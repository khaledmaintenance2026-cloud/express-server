-- ============================================================================
-- صيانتي (Sayanati) — مخطط قاعدة البيانات الكامل
-- PostgreSQL 16 — قاعدة البيانات: sayanati_db
--
-- للتشغيل:
--   psql -U postgres -d sayanati_db -f schema.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- المستخدمون وصلاحياتهم (تسجيل الدخول للنظام)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'production'
                    CHECK (role IN ('admin', 'maintenance', 'production', 'safety', 'contractor')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'revoked')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- الفنيون والمهندسون (قسم إدارة الفنيين)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technicians (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  phone           TEXT,
  specialty       TEXT NOT NULL DEFAULT 'عام', -- نص حر، يمكن أن يحوي أكثر من تخصص مفصولة بفاصلة (مثال: "كهرباء، ميكانيكا")
  status          TEXT NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'busy', 'on_leave')),
  user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- خطوط الإنتاج والمعدات (قسم الإنتاج وخطوط التشغيل)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_lines (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  location        TEXT NOT NULL DEFAULT 'المستودع العام'
                    CHECK (location IN ('المستودع العام', 'مصنع الرجال', 'مصنع النساء')),
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment (
  id              BIGSERIAL PRIMARY KEY,
  line_id         BIGINT REFERENCES production_lines(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  code            TEXT,
  type            TEXT NOT NULL DEFAULT 'أخرى', -- نص حر (مضخة، محرك، سير ناقل...) بدون قائمة مقفلة
  -- مصنع/قسم المعدة (نفس نص ProductionLine.location مثل "مصنع الرجال")
  -- يُستخدم فقط عندما لا تكون المعدة مرتبطة بخط (line_id فارغ)، حتى لا تظهر
  -- معدة "بدون خط محدد" أُضيفت من قسم معيّن في قسم آخر (راجع equipmentByFacility
  -- في app_state.dart وmigrate-equipment-facility.js).
  facility        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ترحيل: إزالة قيد النوع القديم (كان يحصر equipment.type بقائمة مغلقة) لو كان
-- موجودًا من نسخة سابقة من هذا الملف — الأنواع الآن نص حر بدون تقييد.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_type_check') THEN
    ALTER TABLE equipment DROP CONSTRAINT equipment_type_check;
  END IF;
END $$;

-- ترحيل: إزالة قيد التخصص القديم (كان يحصر technicians.specialty بقائمة
-- مغلقة من ٥ خيارات فقط ويمنع اختيار أكثر من تخصص) لو كان موجودًا من نسخة
-- سابقة — التخصص الآن نص حر يمكن أن يحوي أكثر من تخصص مفصولة بفاصلة.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'technicians_specialty_check') THEN
    ALTER TABLE technicians DROP CONSTRAINT technicians_specialty_check;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- بلاغات أعطال الإنتاج الفورية + تتبع زمن التوقف (Downtime)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_reports (
  id                BIGSERIAL PRIMARY KEY,
  line_id           BIGINT REFERENCES production_lines(id) ON DELETE SET NULL,
  equipment_id      BIGINT REFERENCES equipment(id) ON DELETE SET NULL,
  description       TEXT NOT NULL,
  reported_by       TEXT NOT NULL,
  reported_by_user  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  downtime_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  downtime_ended_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'linked', 'closed')),
  photo_path        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- تصاريح العمل الآمن (PTW) — Safety & HSE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS safety_permits (
  id                BIGSERIAL PRIMARY KEY,
  permit_type       TEXT NOT NULL
                      CHECK (permit_type IN ('hot_work', 'confined_space', 'height', 'electrical')),
  location          TEXT NOT NULL,
  description       TEXT NOT NULL,
  requested_by      TEXT NOT NULL,
  requested_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  workers_count     INT NOT NULL DEFAULT 1,
  ppe_required      TEXT[] NOT NULL DEFAULT '{}',
  related_work_order_id BIGINT, -- FK يُضاف بعد إنشاء work_orders (انظر الأسفل)
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- أوامر العمل / الصيانة (دورة الحياة الكاملة)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_orders (
  id                  BIGSERIAL PRIMARY KEY,
  incident_report_id  BIGINT REFERENCES incident_reports(id) ON DELETE SET NULL,
  equipment_id        BIGINT REFERENCES equipment(id) ON DELETE SET NULL,
  line_id             BIGINT REFERENCES production_lines(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL DEFAULT 'emergency'
                        CHECK (kind IN ('emergency', 'preventive')),
  description         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN (
                          'new', 'pending_assignment', 'waiting_loto',
                          'in_progress', 'waiting_parts', 'completed', 'cancelled'
                        )),
  assigned_technician_id BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
  requires_loto       BOOLEAN NOT NULL DEFAULT false,
  created_by          TEXT NOT NULL,
  created_by_user     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at         TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  close_description   TEXT,
  reminder_interval_days INT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_safety_permits_work_order'
  ) THEN
    ALTER TABLE safety_permits
      ADD CONSTRAINT fk_safety_permits_work_order
      FOREIGN KEY (related_work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ترحيل: السماح بدور "مقاول" (contractor) — حساب لطرف خارجي يستخدم فقط
-- لتقديم طلبات تصاريح العمل الآمن، بدون وصول لبقية أقسام النظام.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'maintenance', 'production', 'safety', 'contractor'));
END $$;

-- ترحيل: تقييد وصول مستخدمي قسم الإنتاج بمصنع واحد فقط (مصنع الرجال أو
-- مصنع النساء) حسب ما يحدّده مدير النظام من لوحة الإدارة — عمود اختياري:
-- NULL يعني بلا أي تقييد (يرى المستخدم كل المصانع كما كان الوضع سابقًا)،
-- وهذا هو الافتراضي لأي مستخدم حالي حتى يُخصَّص له مصنع صراحة. مدير النظام
-- (admin) لا يتأثر بهذا العمود أبدًا مهما كانت قيمته.
ALTER TABLE users ADD COLUMN IF NOT EXISTS production_facility TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_production_facility_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_production_facility_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_production_facility_check
    CHECK (production_facility IS NULL OR production_facility IN ('مصنع الرجال', 'مصنع النساء', 'المستودع العام'));
END $$;

-- ترحيل: رقم هاتف كل مستخدم (نص حر، اختياري) — يُدخله المستخدم نفسه عند
-- التسجيل، ويقدر مدير النظام على إضافته أو تعديله لاحقًا من لوحة الإدارة
-- (تطبيق الجوال أو لوحة الويب) لأي مستخدم، بما في ذلك من سجّل قبل هذه الميزة.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- ترحيل: تقسيم دور "الصيانة" العام إلى دورين محددين — فني صيانة
-- (maintenance_technician، ينفّذ الإصلاحات) ومسؤول صيانة (maintenance_manager،
-- يوزّع البلاغات ويدير الفنيين) — بناءً على طلب تمييزهما عند الاعتماد. أي
-- مستخدم كان دوره القديم "maintenance" يتحوّل تلقائيًا إلى "maintenance_manager"
-- (بنفس صلاحياته الكاملة السابقة) حتى لا يفقد أحد صلاحيته بعد هذا التحديث؛
-- يقدر مدير النظام لاحقًا على تعديله إلى "فني صيانة" من شاشة الاعتمادات إن لزم.
UPDATE users SET role = 'maintenance_manager' WHERE role = 'maintenance';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'maintenance_technician', 'maintenance_manager', 'production', 'safety', 'contractor'));
END $$;

-- ترحيل: باتشات الإنتاج — كانت محفوظة محليًا فقط على جهاز المشرف الذي
-- سجّلها (تختفي عند إعادة تشغيل التطبيق ولا تصل لأي جهاز آخر)، الآن تُحفظ
-- على السيرفر فعليًا مثل خطوط الإنتاج والبلاغات تمامًا — يسمح هذا بعرضها
-- من أي جهاز، وإضافة تقارير بمدة مخصصة عليها لاحقًا.
CREATE TABLE IF NOT EXISTS production_batches (
  id                  BIGSERIAL PRIMARY KEY,
  line_id             BIGINT REFERENCES production_lines(id) ON DELETE SET NULL,
  batch_number        TEXT NOT NULL, -- يكتبه مشرف الخط يدويًا، وليس مولَّدًا تلقائيًا
  product_name        TEXT NOT NULL,
  quantity            INTEGER NOT NULL,
  recorded_by         TEXT NOT NULL,
  recorded_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  has_stoppage        BOOLEAN NOT NULL DEFAULT false,
  stoppage_reason     TEXT,
  stoppage_minutes    INTEGER,
  operational_notes   TEXT, -- عامة، مستقلة عن وجود توقف
  actions_taken       TEXT, -- الحلول والإجراءات المتخذة عند التوقف فقط
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_batches_line ON production_batches(line_id);
CREATE INDEX IF NOT EXISTS idx_production_batches_created ON production_batches(created_at);

-- ترحيل: توسيع تصاريح العمل الآمن (safety_permits) لتغطية حقول استمارتَي
-- "تصريح عمل" (طلب) و"إجراءات ومتطلبات السلامة" (اعتماد/رفض) الرسميتين
-- للمصنع. permit_type القديم (نوع واحد فقط من ٤ خيارات) استُبدل بـ
-- operation_types (قائمة متعددة الاختيار) ويبقى العمود القديم دون قيد
-- لأغراض التوافق مع بيانات قديمة فقط.
ALTER TABLE safety_permits ALTER COLUMN permit_type DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'safety_permits_permit_type_check') THEN
    ALTER TABLE safety_permits DROP CONSTRAINT safety_permits_permit_type_check;
  END IF;
END $$;

ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS office_name        TEXT;
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS start_at           TIMESTAMPTZ;
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS end_at             TIMESTAMPTZ;
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS responsible_phone  TEXT;
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS operation_types    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS equipment_used     TEXT;
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS equipment_photo    TEXT;
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS site_hazards       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS potential_risks    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE safety_permits ADD COLUMN IF NOT EXISTS precautions        TEXT;

-- ترحيل: تقسيم قسم السلامة إلى قسمين (رجال/نساء) — كل مسؤول سلامة يقدر
-- يُقيَّد الآن بقسم واحد فقط (نفس فكرة production_facility تمامًا، لكن بعمود
-- مستقل خاص بدور "السلامة" فقط، حتى لا يتأثر مسؤول إنتاج بتقييد سلامة أو
-- العكس لو تغيّر دور المستخدم لاحقًا). NULL يعني بلا تقييد (يرى كل تصاريح
-- السلامة من كل الأقسام، بما فيها "المستودع العام") — وهذا الافتراضي لأي
-- مستخدم سلامة حالي أو جديد حتى يُخصَّص له قسم صراحة من لوحة الإدارة، فلا
-- يفقد أحد صلاحيته الحالية بعد هذا التحديث.
ALTER TABLE users ADD COLUMN IF NOT EXISTS safety_facility TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_safety_facility_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_safety_facility_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_safety_facility_check
    CHECK (safety_facility IS NULL OR safety_facility IN ('مصنع الرجال', 'مصنع النساء', 'المستودع العام'));
END $$;

-- ----------------------------------------------------------------------------
-- تحقيق إصابات العمل (QMS-SAF-007) — يطابق استمارة "تقرير تحقيق بالحادث"
-- الورقية بخطواتها الخمس بالضبط (راجع ملف تحقيق الاصابة.docx الذي أرسله
-- المستخدم). عمود department يحمل نفس قيم عمود safety_facility بجدول users
-- بالضبط، فيُستخدم لتقييد الرؤية بنفس منطق قسم السلامة (راجع دالة
-- userSafetyFacility في routes/injuryReports.js وroutes/safetyPermits.js) —
-- على عكس safety_permits لا حاجة هنا لتحليل نص "قسم — تفاصيل" لأن هذا الحقل
-- قيمة قسم صِرفة دائمًا، وموقع الحادث بالتفصيل له عمود مستقل (incident_location).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS injury_reports (
  id                        BIGSERIAL PRIMARY KEY,
  incident_number           TEXT,
  department                TEXT NOT NULL
                              CHECK (department IN ('مصنع الرجال', 'مصنع النساء', 'المستودع العام')),
  investigation_date        DATE NOT NULL DEFAULT current_date,

  -- رأس الاستمارة: طبيعة الحادث ونوع الإصابة/المرض — اختيار متعدد
  nature_of_accident        TEXT[] NOT NULL DEFAULT '{}',
  injury_types              TEXT[] NOT NULL DEFAULT '{}',

  -- الخطوة الثانية: ظروف الحادث
  incident_location         TEXT NOT NULL,
  occurred_at               TIMESTAMPTZ NOT NULL,
  workday_part              TEXT,
  workday_part_other        TEXT,
  witness_statements        BOOLEAN NOT NULL DEFAULT false,
  photographs_taken         BOOLEAN NOT NULL DEFAULT false,
  maps_drawings             BOOLEAN NOT NULL DEFAULT false,
  ppe_used                  TEXT[] NOT NULL DEFAULT '{}',
  incident_description      TEXT NOT NULL,

  -- الخطوة الثالثة: تحليل السبب الجذري (مدعوم بمخطط "Incidents Causes Analysis"
  -- في الاستمارة الورقية — يُعرض كمرجع في شاشة التطبيق دون تخزينه كبيانات).
  unsafe_condition_reason   TEXT,
  unsafe_act_reason         TEXT,
  had_reward_incentive      BOOLEAN,
  reported_before           BOOLEAN,
  similar_incidents_before  BOOLEAN,

  -- الخطوة الرابعة: هرم الضوابط (Hierarchy of Controls) وإجراءات الوقاية
  hierarchy_of_control      TEXT,
  control_details           TEXT,
  prevention_changes        TEXT[] NOT NULL DEFAULT '{}',
  prevention_changes_other  TEXT,
  prevention_notes          TEXT,

  -- الخطوة الخامسة: من كتب/اعتمد التقرير
  written_by                TEXT,
  written_by_title          TEXT,
  approved_by               TEXT,
  approved_by_title         TEXT,
  approved_at               TIMESTAMPTZ,

  status                    TEXT NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'closed')),
  reported_by               TEXT NOT NULL,
  reported_by_user          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- الخطوة الأولى: بيانات كل موظف مصاب — سجل مستقل لكل مصاب (يمكن تكراره).
CREATE TABLE IF NOT EXISTS injury_report_employees (
  id                    BIGSERIAL PRIMARY KEY,
  injury_report_id      BIGINT NOT NULL REFERENCES injury_reports(id) ON DELETE CASCADE,
  employee_name         TEXT NOT NULL,
  nationality           TEXT,
  employee_id_no        TEXT,
  age                   INT,
  department            TEXT,
  job_title             TEXT,
  shift                 TEXT,
  body_parts_affected   TEXT[] NOT NULL DEFAULT '{}',
  body_injury_side      TEXT, -- 'front' | 'back' | NULL (غير محدد) — راجع migrate-body-injury-side.js
  body_diagram_image    TEXT, -- مسار نسبي لرسمة تفاعلية رسمها المستخدم بإصبعه فوق مخطط الجسم (راجع migrate-body-diagram-image.js وBodyDiagramDrawer في التطبيق)
  lost_work_days        INT NOT NULL DEFAULT 0,
  employment_type       TEXT,
  months_in_job         INT,
  months_in_company     INT,
  injury_nature         TEXT[] NOT NULL DEFAULT '{}',
  injury_nature_other   TEXT,
  is_fatality           BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- الخطوة الرابعة: جدول متابعة الإجراءات التصحيحية/الوقائية (Action / Responsibility / Sign / Timeline)
CREATE TABLE IF NOT EXISTS injury_report_actions (
  id                  BIGSERIAL PRIMARY KEY,
  injury_report_id    BIGINT NOT NULL REFERENCES injury_reports(id) ON DELETE CASCADE,
  action_description  TEXT NOT NULL,
  responsible_person  TEXT,
  target_date         DATE,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  completed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- الخطوة الخامسة: أعضاء فريق التحقيق (حتى ٣ أعضاء كما في الاستمارة الورقية،
-- لكن دون تقييد صارم على العدد هنا).
CREATE TABLE IF NOT EXISTS injury_report_investigators (
  id                  BIGSERIAL PRIMARY KEY,
  injury_report_id    BIGINT NOT NULL REFERENCES injury_reports(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  job_title           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_injury_reports_status ON injury_reports(status);
CREATE INDEX IF NOT EXISTS idx_injury_reports_department ON injury_reports(department);
CREATE INDEX IF NOT EXISTS idx_injury_report_employees_report ON injury_report_employees(injury_report_id);
CREATE INDEX IF NOT EXISTS idx_injury_report_actions_report ON injury_report_actions(injury_report_id);
CREATE INDEX IF NOT EXISTS idx_injury_report_investigators_report ON injury_report_investigators(injury_report_id);

-- ----------------------------------------------------------------------------
-- إجراءات العزل الآمن LOTO — مرتبطة بأمر عمل
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loto_logs (
  id              BIGSERIAL PRIMARY KEY,
  work_order_id   BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  energy_type     TEXT NOT NULL
                    CHECK (energy_type IN ('electrical', 'hydraulic', 'mechanical', 'pneumatic')),
  isolation_point TEXT NOT NULL,
  locked_by       TEXT,
  locked_at       TIMESTAMPTZ,
  verified_by     TEXT,
  verified_at     TIMESTAMPTZ,
  released_by     TEXT,
  released_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'locked', 'verified', 'released')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- قطع الغيار المستهلكة في كل أمر عمل
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spare_parts_used (
  id              BIGSERIAL PRIMARY KEY,
  work_order_id   BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  part_name       TEXT NOT NULL,
  quantity        INT NOT NULL DEFAULT 1,
  unit_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- بلاغات السلامة / الحوادث الوشيكة (Near Miss & Hazard Reporting)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS near_miss_reports (
  id              BIGSERIAL PRIMARY KEY,
  location        TEXT NOT NULL,
  hazard_type     TEXT NOT NULL,
  description     TEXT NOT NULL,
  reported_by     TEXT NOT NULL,
  reported_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'reviewed', 'closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- إعدادات الويبهوك / تكامل واتساب
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  event_type      TEXT NOT NULL
                    CHECK (event_type IN (
                      'incident_created', 'work_order_assigned', 'work_order_completed',
                      'safety_permit_requested', 'safety_permit_reviewed', 'near_miss_reported'
                    )),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ترحيل: تقييد ويبهوك واحد (مثال: واتساب مصنع الرجال) بمصنع إنتاج محدد —
-- عمود اختياري: NULL يعني يُرسَل هذا الويبهوك عند كل حدث من نوعه بغضّ النظر
-- عن المصنع (وهذا الوضع الافتراضي لأي ويبهوك حالي)، أما إن حُدِّد مصنع فلن
-- يُرسَل إلا للأحداث التي تحمل نفس المصنع (حاليًا: بلاغات الإنتاج فقط، لأنها
-- الحدث الوحيد المرتبط بخط إنتاج وبالتالي بمصنع).
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS facility TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhooks_facility_check') THEN
    ALTER TABLE webhooks DROP CONSTRAINT webhooks_facility_check;
  END IF;
  ALTER TABLE webhooks ADD CONSTRAINT webhooks_facility_check
    CHECK (facility IS NULL OR facility IN ('مصنع الرجال', 'مصنع النساء', 'المستودع العام'));
END $$;

-- ترحيل: نص رسالة مخصّص اختياري لكل ويبهوك — يدعم استبدال {{field}} بقيمة
-- الحقل المقابل من حمولة الحدث (raw payload) عند الإرسال، بدل الاعتماد
-- الكامل على تنسيق النص في أتمتة خارجية (n8n مثلاً). NULL يعني عدم إرسال
-- نص جاهز (يبقى الاعتماد كليًا على data الخام كما كان الوضع سابقًا).
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS message_template TEXT;

-- ----------------------------------------------------------------------------
-- إعدادات الموقع العامة (System Settings) — صف واحد بمفتاح/قيمة
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);

INSERT INTO site_settings (key, value) VALUES
  ('factory_name', 'مصنع الماس الوطنية'),
  ('report_footer', 'تم إنشاء هذا التقرير تلقائيًا من نظام صيانتي')
ON CONFLICT (key) DO NOTHING;

-- ترحيل: رابط السيرفر العام (رابط Cloudflare مثلاً) — يُستخدم لبناء رابط
-- كامل (مطلَق) لتقارير الإنتاج المولَّدة (services/productionReport.js)
-- حتى يعمل الرابط عند فتحه من واتساب خارج شبكة المصنع، لا رابطًا محليًا
-- (localhost/192.168.x.x) لا يعمل إلا داخل نفس الشبكة.
INSERT INTO site_settings (key, value) VALUES
  ('public_base_url', '')
ON CONFLICT (key) DO NOTHING;

-- ترحيل: عدد العمال في كل باتش إنتاج — حقل جديد يطابق عمود "workers" في
-- التقرير الأسبوعي الورقي القديم الذي كان يُعبّأ يدويًا قبل هذا النظام.
ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS workers_count INTEGER;

-- ترحيل: نقل نظام الصيانة (بلاغات الأعطال الطارئة + أوامر العمل الوقائية)
-- من بيانات وهمية محلية على كل جهاز (كانت تختفي عند إعادة تشغيل التطبيق، لا
-- تصل لأي جهاز آخر، ولا ترسل أي إشعار واتساب حقيقي رغم أن الواجهة كانت
-- تعرض نصًا يوحي بذلك) إلى جدول work_orders الحقيقي الموجود مسبقًا على
-- السيرفر. عمودان وصفيان بسيطان (نص حر، بلا ربط بجداول أخرى) لعرض "المعدة"
-- و"المصنع/القسم" في واجهة التطبيق كما كانا تمامًا — equipment_id وline_id
-- يبقيان اختياريين كما هما لاستخدام أدق مستقبلًا لو رغبتم بذلك لاحقًا.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS equipment_name TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS facility TEXT;

-- ترحيل: "رمز الخط" المختصر (مثل LINE-07) المستخدم في جدول ملخص التقرير
-- الأسبوعي الجديد لكل خط إنتاج — نص حر اختياري، لو تُرك فارغًا يستخدم
-- التقرير اسم الخط نفسه بدلاً منه (راجع services/productionReport.js).
-- عدّلوا الرموز حسب رغبتكم عبر pgAdmin، مثال:
--   UPDATE production_lines SET code = 'LINE-07' WHERE name = 'خط ٧';
ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS code TEXT;

-- ترحيل: "كود المكينة" — حقل نصي حر اختياري يُضاف عند إنشاء أمر عمل وقائي
-- جديد، يظهر لاحقًا بجانب اسم المعدة في رسائل واتساب وتقرير الصيانة.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS equipment_code TEXT;

-- ترحيل: تصنيف حدة العطل (بسيط/متوسط/حرج) عند رفع بلاغ عطل من الإنتاج —
-- اختياري (NULL) حفاظًا على توافق البلاغات القديمة وأي نسخة تطبيق لم تُحدَّث
-- بعد؛ يظهر في رسالة واتساب "بلاغ عطل مفاجئ" الجديدة.
ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS severity TEXT
  CHECK (severity IN ('simple', 'medium', 'critical'));

-- ترحيل: دعم تعيين أكثر من فني لنفس أمر العمل — كان النظام يسمح بفني واحد
-- فقط (عمود assigned_technician_id). هذا العمود يبقى كما هو تمامًا (يحمل
-- "الفني الأساسي" — أول فني يُختار — لأي كود قديم ما زال يقرأه)، والجدول
-- التالي يحمل القائمة الكاملة للفنيين المُسنَد إليهم أمر العمل نفسه.
CREATE TABLE IF NOT EXISTS work_order_technicians (
  work_order_id  BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  technician_id  BIGINT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  PRIMARY KEY (work_order_id, technician_id)
);
-- ترحيل بيانات قديمة: كل أمر عمل له فني مُسنَد حاليًا يُنسخ تلقائيًا هنا حتى
-- لا تختفي بياناته من رسائل/شاشات الفنيين المتعددين الجديدة.
INSERT INTO work_order_technicians (work_order_id, technician_id)
SELECT id, assigned_technician_id FROM work_orders
WHERE assigned_technician_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ترحيل: "ملاحظات" اختيارية منفصلة عن "بيان العمل المنجز" عند إغلاق أمر العمل.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS close_notes TEXT;

-- ترحيل: "مهام العمل" — تصنيف ثالث لأوامر العمل منفصل عن "بلاغ عطل طارئ"
-- و"صيانة وقائية"، يبادره فريق الصيانة نفسه لمهام عامة داخل المصنع أو خارجه
-- (توصيل، نقل معدات، أعمال إدارية...) لا ترتبط بعطل فعلي في معدة. يبقى
-- kind = 'emergency' لهذه المهام عمدًا (فتظهر في نفس تبويب "الأعطال الطارئة"
-- وتتبع نفس دورة العمل/الإشعارات تمامًا بلا أي كود جديد) — is_task/task_scope
-- فقط للتمييز لاحقًا في التقارير (راجع services/maintenanceReport.js) وواجهة
-- الإنشاء في التطبيق (maintenance_new_report_screen.dart).
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS is_task BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS task_scope TEXT
  CHECK (task_scope IN ('internal', 'external'));

-- ترحيل: تفاصيل إضافية اختيارية لتسجيل الباتش — وقت البدء/الانتهاء الفعلي
-- للباتش (وقت اليوم فقط، بلا تاريخ)، و"طرق تجنّب تكرار المشكلة" (منفصلة عن
-- "الحلول والإجراءات المتخذة" الحالية) — لتطابق صيغة رسالة واتساب الجديدة.
ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS time_from TIME;
ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS time_to TIME;
ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS prevention_methods TEXT;

-- ترحيل: إشعارات داخل التطبيق — لكل مستخدم صف إشعاراته الخاصة فقط (يظهر له
-- عند فتح جرس الإشعارات في التطبيق)، بديل خفيف الوزن عن إشعارات نظام Push
-- الحقيقية (التي تحتاج ربط خدمة Firebase منفصلة، غير موجودة بالنظام بعد).
CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  event_type   TEXT,
  ref_id       BIGINT,
  is_read      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ترحيل: دور جديد "مسؤول إنتاج" (production_manager) — يملك كل صلاحيات
-- "إنتاج" العادي (production) بالإضافة لصلاحية تعديل أو حذف باتش بعد
-- تسجيله (موظف الإنتاج العادي يسجّل فقط، ولا يعدّل ولا يحذف بعد اليوم).
-- لا يتحوّل أي حساب تلقائيًا لهذا الدور — مدير النظام يُسنده يدويًا لمن يشاء
-- من شاشة الاعتمادات.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'maintenance_technician', 'maintenance_manager', 'production', 'production_manager', 'safety', 'contractor'));
END $$;

-- ترحيل: التاريخ/الوقت "الفعلي" للباتش — منفصل عمدًا عن created_at الذي
-- يبقى دائمًا وقت الإدخال الحقيقي في النظام (سجل تدقيق لا يتغيّر أبدًا).
-- occurred_at يسمح لموظف الإنتاج بتسجيل باتش بتاريخ سابق (مثلاً باتش نُسي
-- تسجيله أمس) — بلا حد على القدم؛ يُستخدم في عرض القائمة والتقارير ورسالة
-- واتساب بدل created_at. الصفوف القديمة تُملأ بقيمة created_at نفسها حتى لا
-- ينكسر أي ترتيب أو تقرير سابق.
ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
UPDATE production_batches SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE production_batches ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE production_batches ALTER COLUMN occurred_at SET DEFAULT now();

-- ترحيل: سجل تعديلات الباتش — كل تعديل يجريه "مسؤول إنتاج" على باتش قديم
-- يُسجَّل هنا (من عدّل، متى، وما الحقول التي تغيّرت مع قيمتها القديمة
-- والجديدة كـ JSON) — للرجوع إليه لاحقًا عند الحاجة، ولا يُعرض تلقائيًا إلا
-- عند طلبه صراحةً (GET /api/production/batches/:id/edits).
CREATE TABLE IF NOT EXISTS production_batch_edits (
  id              BIGSERIAL PRIMARY KEY,
  batch_id        BIGINT NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  edited_by_user  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  edited_by_name  TEXT,
  edited_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  changes         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_production_batch_edits_batch ON production_batch_edits(batch_id, edited_at DESC);

-- ترحيل: تسجيل الدخول عبر جوجل — google_sub هو المعرّف الثابت الذي ترسله
-- جوجل لكل حساب (لا يتغيّر أبدًا، بعكس البريد الذي قد يُحرَّر نظريًا)، يُستخدم
-- لربط الحساب بحساب جوجل صاحبه. UNIQUE يمنع ربط نفس حساب جوجل بأكثر من
-- مستخدم. القيمة null لكل الحسابات القديمة (سجّلت ببريد/كلمة مرور فقط) وتبقى
-- كذلك إلا لو سجّل صاحبها دخولًا عبر جوجل بنفس بريده مرة، فيُربط تلقائيًا.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;

-- إعدادات اختيارية للتقرير الأسبوعي الجديد (تُقرأ بقيمة افتراضية معقولة لو لم
-- تُضبط أبدًا، فلا حاجة لإضافتها هنا إجباريًا؛ فقط وثّقناها للمرجعية):
--   report_timezone_offset_hours  — فرق التوقيت المحلي عن UTC بالساعات
--                                    (افتراضي 3، أي توقيت السعودية/الخليج
--                                    بدون توقيت صيفي). عدّلوه لو المصنع في
--                                    منطقة زمنية مختلفة.
--   production_shift_minutes_per_day — دقائق التشغيل المتوقعة يوميًا لكل خط
--                                    (افتراضي 480 = ٨ ساعات) — تُستخدم فقط
--                                    لحساب "نسبة التوقف %" التقديرية في
--                                    ملخص التقرير الأسبوعي.

-- ترحيل: قسم "المخزون والقطع" الجديد بالصيانة — دوران جديدان في جدول
-- المستخدمين: "مسؤول المخزون" (inventory_manager، يصرف/يرجع القطع فعليًا من
-- كتالوج المخزون) و"مصمم" (designer، يستلم طلبات القطع التي تحتاج تصميمًا
-- قبل توفّرها ويرفع نتيجة التصميم). قرار صريح من الإدارة (2026-09-23):
-- إدارة الكتالوج نفسه (إضافة/تعديل أصناف وكميات) تُحصر بمسؤول الصيانة
-- ومسؤول المخزون معًا (وليس أي فني) — راجع INVENTORY_MANAGE_ROLES في
-- middleware/auth.js وroutes/inventory.js.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN (
      'admin', 'maintenance_technician', 'maintenance_manager', 'production', 'production_manager',
      'safety', 'contractor', 'general', 'inventory_manager', 'designer'
    ));
END $$;

-- الموردون — سجل مستقل (اسم، جهة اتصال، هاتف، بريد، عنوان، نشط/غير نشط)
-- يمكن ربط أي صنف مخزون به اختياريًا (inventory_items.supplier_id أدناه)،
-- بلا أي أثر إلزامي — صنف بلا مورّد محدَّد يبقى يعمل بلا أي مشكلة.
CREATE TABLE IF NOT EXISTS suppliers (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  contact_name    TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- مواقع العمل — كيانات مُدارة من شاشة مخصّصة (بدل حقل نص حر) يمكن ربط أي
-- صنف مخزون بواحد منها اختياريًا (inventory_items.site_id أدناه) لتحديد أين
-- يُخزَّن فعليًا (مثال: "المستودع الرئيسي"، "خط الإنتاج ١").
CREATE TABLE IF NOT EXISTS work_sites (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  notes           TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- كتالوج أصناف المخزون والقطع. category نص حر عمدًا (بدل جدول فئات منفصل
-- بحاجة شاشة إدارة خاصة به) — التطبيق يقترح الفئات المستخدمة سابقًا تلقائيًا
-- (راجع previousInventoryCategories في app_state.dart)، بنفس فكرة اقتراح
-- "مواقع مهام العمل" السابقة تمامًا؛ يبقى الحقل حرًا يقبل فئة جديدة أي وقت.
-- min_quantity اختياري (تنبيه "منخفض" في الواجهة لو النازل تحته أو يساويه)،
-- بلا أي أثر إلزامي على السيرفر. supplier_id وsite_id اختياريان (راجع
-- جدولي suppliers وwork_sites أعلاه).
CREATE TABLE IF NOT EXISTS inventory_items (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT,
  unit            TEXT NOT NULL DEFAULT 'قطعة',
  quantity        INT NOT NULL DEFAULT 0,
  min_quantity    INT,
  notes           TEXT,
  supplier_id     BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  site_id         BIGINT REFERENCES work_sites(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- طلبات القطع — يرفعها فني الصيانة (أو مسؤول الصيانة)، وتمر اختياريًا بمرحلة
-- "تصميم" (needs_design) قبل أن تصل لمرحلة "بانتظار الصرف". العدد لا يُخصم من
-- inventory_items.quantity إلا لحظة تأكيد الصرف الفعلي (PATCH /:id/issue)
-- من مسؤول المخزون أو مسؤول الصيانة — وليس لحظة تقديم الطلب — تمامًا كما طلبت
-- الإدارة: "الفني يطلب، والمسؤول على المخزن يعطيه ويؤكد الإعطاء". لو أُنجزت
-- المهمة بدون استخدام القطعة فعليًا، PATCH /:id/return يعيد العدد للمخزون.
-- item_id قابل لأن يكون NULL (قطعة مخصّصة غير مكتلَنة بعد تحتاج تصميمًا خاصًا
-- قبل توفيرها) — عندها item_name وحده يحمل الاسم الحر، ولا تأثير فعليًا على
-- أي رصيد مخزون عند صرفها (لا يوجد صنف كتالوج يُخصَم منه أصلًا).
CREATE TABLE IF NOT EXISTS part_requests (
  id                  BIGSERIAL PRIMARY KEY,
  item_id             BIGINT REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name           TEXT NOT NULL,
  quantity            INT NOT NULL DEFAULT 1,
  work_order_id       BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
  notes               TEXT,
  needs_design        BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'pending_issue'
                        CHECK (status IN ('pending_design', 'pending_issue', 'issued', 'returned')),
  requested_by        TEXT NOT NULL,
  requested_by_user   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  technician_id       BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
  design_file_url     TEXT,
  design_notes        TEXT,
  designed_by         TEXT,
  designed_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  designed_at         TIMESTAMPTZ,
  issued_by           TEXT,
  issued_by_user      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  issued_at           TIMESTAMPTZ,
  returned_at         TIMESTAMPTZ,
  return_notes        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- سجل حركات المخزون — صف دائم لكل عملية تُغيّر رصيد صنف استهلاكي أو حالة
-- عدة عهدة (لا يُحذَف ولا يُعدَّل أبدًا بعد إنشائه). سجل موحّد يخدم كلاً من
-- كتالوج المخزون الاستهلاكي (routes/inventory.js) وكتالوج العهدة
-- (routes/custody.js) معًا — لهذا item_id بلا ربط صارم (Foreign Key) بجدول
-- بعينه: قد يشير لـ inventory_items أو لـ custody_items حسب عمود source،
-- وitem_name نسخة نصية وقت الحركة تكفي للعرض والمراجعة حتى لو حُذف السجل
-- الأصلي لاحقًا. ستة أنواع (type) تطابق تصنيف نظام "مخزني بلس" المرجعي:
--   • supply             (توريد)         — رصيد ابتدائي عند إضافة صنف، توريد
--                                          سريع لصنف قائم، أو إرجاع طلب قطعة
--                                          صُرف ولم يُستخدم — كلها "وارد".
--   • consumable_issue   (صرف استهلاكي)  — صرف طلب قطعة (تأكيد الصرف الفعلي)
--                                          أو صرف سريع مباشر من نفس الشاشة.
--   • custody_issue      (صرف معدات)     — تسليم عدة عهدة لفني.
--   • custody_return     (إعادة معدات)   — استرجاع عدة عهدة من فني.
--   • stock_reconciliation (تسوية جرد)   — تصحيح الرصيد لكمية معدودة فعليًا
--                                          (شاشة/إجراء "تسوية جرد" المخصص —
--                                          منفصل تمامًا عن تعديل الصنف الكامل
--                                          أدناه بقرار صريح من الإدارة).
--   • stock_adjustment   (تعديل مخزون)   — تصحيح الكمية كجزء من تعديل بيانات
--                                          الصنف الكامل (نموذج "تعديل الصنف")
--                                          — عملية مختلفة تمامًا عن تسوية
--                                          الجرد أعلاه رغم تشابههما ظاهريًا.
-- quantity_delta/quantity_after فارغتان (NULL) عمدًا لحركات العهدة (source =
-- 'custody') لأن كل عدة عنصر واحد بحالة متاح/مُسلَّم لا رصيد رقمي له أصلًا؛
-- موجب = زيادة، سالب = نقصان لبقية الأنواع. راجع services/inventoryMovements.js
-- (logMovement) ونقاط استدعائها في routes/inventory.js وroutes/custody.js.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id                  BIGSERIAL PRIMARY KEY,
  item_id             BIGINT,
  item_name           TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('supply', 'consumable_issue', 'custody_issue', 'custody_return', 'stock_reconciliation', 'stock_adjustment')),
  source              TEXT NOT NULL DEFAULT 'inventory' CHECK (source IN ('inventory', 'custody')),
  quantity_delta      INT,
  quantity_after      INT,
  part_request_id     BIGINT REFERENCES part_requests(id) ON DELETE SET NULL,
  performed_by        TEXT NOT NULL,
  performed_by_user   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "العهدة" — عدة ومعدات (دريل، إلخ) تُسلَّم لفني كعهدة ويرجعها لاحقًا، بعكس
-- قطع الغيار الاستهلاكية أعلاه (inventory_items/part_requests) التي تُصرف
-- ولا ترجع. راجع routes/custody.js لشرح دورة الحالة الكاملة: العدة
-- "available" ← تُسلَّم لفني (صف جديد في custody_assignments + status
-- العدة → 'assigned') ← تُسترجع (returned_at يُملأ في نفس الصف + status
-- العدة → 'available' من جديد). لا يوجد "كمية" هنا — كل عدة صف كتالوج
-- مستقل بذاته (حتى لو تكرر الاسم، كل دريل له صف خاص به وحالته الخاصة).
CREATE TABLE IF NOT EXISTS custody_items (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT,
  code            TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_assignments (
  id                  BIGSERIAL PRIMARY KEY,
  item_id             BIGINT NOT NULL REFERENCES custody_items(id) ON DELETE CASCADE,
  work_order_id       BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
  assigned_to         TEXT NOT NULL,
  technician_id       BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
  assigned_by         TEXT NOT NULL,
  assigned_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_return_at  TIMESTAMPTZ,
  notes               TEXT,
  returned_at         TIMESTAMPTZ,
  return_notes        TEXT,
  returned_by         TEXT,
  returned_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL
);

-- يمنع وجود أكثر من تسليم مفتوح (غير مُرجَع) لنفس العدة في وقت واحد — شبكة
-- أمان إضافية بمستوى قاعدة البيانات فوق التحقق الموجود أصلًا في الكود
-- (SELECT ... FOR UPDATE داخل معاملة قبل الإدراج).
CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_one_open_assignment ON custody_assignments(item_id) WHERE returned_at IS NULL;

-- ----------------------------------------------------------------------------
-- الفهارس (Indexes) لتسريع الاستعلامات الأكثر استخدامًا
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_technician ON work_orders(assigned_technician_id);
CREATE INDEX IF NOT EXISTS idx_incident_reports_status ON incident_reports(status);
CREATE INDEX IF NOT EXISTS idx_safety_permits_status ON safety_permits(status);
CREATE INDEX IF NOT EXISTS idx_custody_items_status ON custody_items(status);
CREATE INDEX IF NOT EXISTS idx_custody_assignments_item ON custody_assignments(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_created ON inventory_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_inventory_items_supplier ON inventory_items(supplier_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_site ON inventory_items(site_id);
CREATE INDEX IF NOT EXISTS idx_loto_logs_work_order ON loto_logs(work_order_id);
CREATE INDEX IF NOT EXISTS idx_spare_parts_work_order ON spare_parts_used(work_order_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_part_requests_status ON part_requests(status);
CREATE INDEX IF NOT EXISTS idx_part_requests_work_order ON part_requests(work_order_id);

-- ----------------------------------------------------------------------------
-- بيانات ابتدائية بسيطة لتجربة النظام فورًا (يمكن حذفها لاحقًا)
-- ----------------------------------------------------------------------------
INSERT INTO production_lines (name, location, active) VALUES
  ('خط ٧', 'المستودع العام', true),
  ('خط ٨', 'المستودع العام', true),
  ('خط ٩', 'مصنع الرجال', true),
  ('خط ١٠', 'مصنع الرجال', true),
  ('خط ١١', 'مصنع النساء', true),
  ('خط ١٢', 'مصنع النساء', true)
ON CONFLICT (name) DO NOTHING;

-- ترحيل: ربط باتش الإنتاج بأمر صيانة فعلي — يحل ثغرة "كيف سوف يسجل الباتش
-- أنه تأخر بسبب الصيانة" (طلب 2026-09-29). عند تحديد work_order_id لباتش،
-- تُحسَب حقول التوقف الثلاثة (has_stoppage/stoppage_reason/stoppage_minutes)
-- تلقائيًا من بيانات أمر العمل نفسه (ومن بلاغ العطل المرتبط به إن وُجد) بدل
-- إدخالها يدويًا — راجع services/batchWorkOrderLink.js وmigrate-batch-work-
-- order-link.js. ON DELETE SET NULL: حذف أمر العمل (نادر) لا يحذف الباتش،
-- فقط يفك ربطه.
ALTER TABLE production_batches
  ADD COLUMN IF NOT EXISTS work_order_id BIGINT REFERENCES work_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_production_batches_work_order ON production_batches(work_order_id);

-- ترحيل: "رقم الباتش المتوقع" — يحل ثغرة تاريخ الأحداث: بلاغ العطل يُرفع
-- لحظة حدوثه فعليًا، لكن الباتش المتأثر به لا يُسجَّل في النظام إلا لاحقًا
-- (بعد انتهاء الباتش وحساب كميته النهائية)، فلا يوجد باتش فعلي بعد يمكن
-- ربطه به وقت رفع البلاغ (طلب 2026-09-29). الحل: مشرف الإنتاج يكتب رقم
-- الباتش المتوقع عند رفع البلاغ نفسه (عمود جديد على بلاغ العطل)، وعمود
-- مطابق على أمر العمل يُنسَخ إليه تلقائيًا عند تحويل البلاغ لأمر عمل (راجع
-- routes/workOrders.js). لاحقًا، عند تسجيل الباتش فعليًا برقم مطابق على نفس
-- الخط (بلا ربط يدوي)، يكتشفه السيرفر تلقائيًا ويربطه بنفسه — راجع
-- findAutoLinkWorkOrder في services/batchWorkOrderLink.js وmigrate-expected-
-- batch-number.js.
ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS expected_batch_number TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS expected_batch_number TEXT;
CREATE INDEX IF NOT EXISTS idx_work_orders_expected_batch ON work_orders(line_id, expected_batch_number);

-- ترحيل: من قام بتعيين الفني (2026-10-06) — الاسم للعرض + معرّف الحساب. يُضاف
-- أيضًا تلقائيًا عند تشغيل السيرفر (routes/workOrders.js ensureAssignedByColumns).
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS assigned_by TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS assigned_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL;
