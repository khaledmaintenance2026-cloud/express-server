'use strict';
// ============================================================================
// تقارير «إجازات الموظفين»: تحميل البيانات من القاعدة ثم بناء النموذج (lib/leaveReport.js)
// وإخراجه HTML للطباعة أو ملف Excel. لا يعدّل شيئًا في القاعدة.
// ============================================================================

const { pool } = require('../config/db');
const C = require('../lib/leaveCalc');
const R = require('../lib/leaveReport');
const svc = require('./leaveService');

/** يتحقق من معاملات التقرير: employeeId اختياري (كشف شخص) و status اختياري (فلتر الشامل). */
function readOptions(query) {
  const q = query || {};
  let employeeId = null;
  if (q.employeeId !== undefined && q.employeeId !== null && q.employeeId !== '') {
    employeeId = svc.parseId(q.employeeId);
    if (!employeeId) throw svc.badRequest('معرّف الموظف غير صحيح');
  }
  let status = null;
  if (q.status !== undefined && q.status !== null && q.status !== '') {
    if (!R.STATUS_FILTERS.includes(String(q.status))) throw svc.badRequest('فلتر الحالة غير صحيح');
    status = String(q.status);
  }
  if (employeeId && status) throw svc.badRequest('فلتر الحالة للتقرير الشامل فقط');
  return { employeeId, status };
}

/** يبني نموذج التقرير المطلوب (شخص أو شامل). */
async function buildModel(options, now = new Date()) {
  const settings = await svc.getSettings();
  const todayDay = C.todayDay(now);

  if (options.employeeId) {
    const data = await svc.loadOne(pool, options.employeeId);
    if (!data) throw new svc.HttpError(404, 'الموظف غير موجود');
    const view = svc.buildView(data.employee, data.leaves, todayDay, settings, { full: true });
    return R.buildPersonModel(view, todayDay, settings, { now });
  }

  const { employees, leavesByEmp } = await svc.loadAll();
  const views = employees.map((e) => svc.buildView(e, leavesByEmp.get(Number(e.id)) || [], todayDay, settings, { full: true }));
  return R.buildAllModel(views, todayDay, { status: options.status, now });
}

/** تقرير للعرض/الطباعة: يعيد HTML جاهزًا + بيانات وصفية. */
async function buildHtmlReport(options, now = new Date()) {
  const model = await buildModel(options, now);
  const out = model.kind === 'person' ? R.renderPersonHtml(model) : R.renderAllHtml(model);
  return {
    today: model.today,
    kind: model.kind,
    title: out.title,
    subtitle: out.subtitle,
    orientation: out.orientation,
    filename: out.filename,
    count: model.kind === 'person' ? model.leaves.length : model.rows.length,
    html: out.html,
  };
}

/** ملف Excel: {buffer, filename}. */
async function buildExcel(options, now = new Date()) {
  const model = await buildModel(options, now);
  if (model.kind === 'person') {
    const e = model.employee;
    const num = String(e.employee_number || e.id).replace(/[^A-Za-z0-9-]+/g, '') || String(e.id);
    return { buffer: R.personWorkbook(model, now), filename: `leaves-employee-${num}-${model.today}.xlsx` };
  }
  return {
    buffer: R.allWorkbook(model, now),
    filename: `leaves-report-${model.today}${model.status ? `-${model.status}` : ''}.xlsx`,
  };
}

module.exports = { readOptions, buildModel, buildHtmlReport, buildExcel };
