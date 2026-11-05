// migrate-technician-status-reconcile.js
//
// إصلاح لمرة واحدة لحالة "مشغول" العالقة على فنيين لا يوجد لديهم فعليًا أي
// أمر عمل مفتوح — نتيجة ثغرتين في routes/workOrders.js تم إصلاحهما الآن:
//   1) PATCH /:id/status بحالة 'cancelled' كان لا يُعيد الفني/الفنيين
//      المُسنَدين إلى "متاح" (فقط /:id/close كان يفعل ذلك عند الإنجاز).
//   2) DELETE /:id (حذف أمر عمل) كان لا يفعل ذلك أيضًا.
// نتيجة الثغرتين: كل أمر عمل أُلغي أو حُذف بدل إنجازه ترك فنييه "مشغولين"
// للأبد، فتراكمت هذه الحالات الوهمية حتى ظهر أغلب/كل الفنيين "غير متاحين"
// رغم عدم وجود أي عمل فعلي لديهم — هذا ما لاحظه العميل 2026-09-26.
//
// هذا السكربت يبحث عن كل فني حالته 'busy' حاليًا ولا يوجد له أي أمر عمل
// بحالة غير 'completed' و'cancelled' مرتبط به (سواء كـ"فني أساسي" أو ضمن
// تعيين متعدد الفنيين)، ويعيده إلى 'available'. لا يلمس إطلاقًا حالة
// 'on_leave' (قرار إداري صريح لا علاقة له بأوامر العمل) ولا أي فني "مشغول"
// فعلًا بعمل مفتوح حقيقي.
//
// التشغيل: node migrate-technician-status-reconcile.js
// آمن للتكرار (idempotent) — لا يغيّر شيئًا إن أُعيد تشغيله بعد الإصلاح.

'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function main() {
  const { rows: busyTechs } = await pool.query(
    "SELECT id, name FROM technicians WHERE status = 'busy' ORDER BY name"
  );

  if (busyTechs.length === 0) {
    console.log('لا يوجد أي فني بحالة "مشغول" حاليًا — لا شيء لإصلاحه.');
    process.exit(0);
  }

  console.log(`فحص ${busyTechs.length} فني/فنيين بحالة "مشغول"...`);
  let freedCount = 0;

  for (const tech of busyTechs) {
    const { rows } = await pool.query(
      `SELECT 1
         FROM work_orders wo
        WHERE wo.status NOT IN ('completed', 'cancelled')
          AND (
            wo.assigned_technician_id = $1
            OR EXISTS (
              SELECT 1 FROM work_order_technicians wot
               WHERE wot.work_order_id = wo.id AND wot.technician_id = $1
            )
          )
        LIMIT 1`,
      [tech.id]
    );
    const hasOpenWorkOrder = rows.length > 0;

    if (!hasOpenWorkOrder) {
      await pool.query("UPDATE technicians SET status = 'available' WHERE id = $1", [tech.id]);
      console.log(`  ✓ تحرير: ${tech.name} (لا يوجد لديه أي أمر عمل مفتوح فعليًا)`);
      freedCount += 1;
    } else {
      console.log(`  — إبقاء "مشغول": ${tech.name} (لديه أمر عمل مفتوح فعليًا)`);
    }
  }

  console.log(`\nتم تحرير ${freedCount} من أصل ${busyTechs.length} فني كانوا عالقين بالخطأ على "مشغول".`);
  process.exit(0);
}

main().catch((err) => {
  console.error('فشل تشغيل سكربت الإصلاح:', err);
  process.exit(1);
});
