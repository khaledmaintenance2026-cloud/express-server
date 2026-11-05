import '../models/overtime.dart';
import 'api_client.dart';

/// طلبات "العمل الإضافي" إلى سيرفر صيانتي (/api/overtime) — مقصورة على
/// الإداريين (مدير النظام ومسؤول الصيانة) على السيرفر نفسه، فأي مستخدم آخر
/// يتلقى رسالة "ليست لديك صلاحية" (ApiException). كل الدوال ترمي
/// [ApiException] برسالة عربية جاهزة للعرض عند أي خطأ.
class OvertimeService {
  OvertimeService._();

  static final ApiClient _api = ApiClient.instance;

  static List<dynamic> _listOf(dynamic data, String key) {
    if (data is Map) {
      final v = data[key];
      if (v is List) return v;
    }
    return const [];
  }

  // ------------------------------- الأفراد -------------------------------

  static Future<List<OvertimeEmployee>> fetchEmployees() async {
    final data = await _api.get('/overtime/employees');
    return _listOf(data, 'employees').map((e) => OvertimeEmployee.fromApi(e as Map<String, dynamic>)).toList();
  }

  static Future<OvertimeEmployee> addEmployee({required String name, String? employeeNumber}) async {
    final data = await _api.post('/overtime/employees', {
      'name': name,
      'employeeNumber': employeeNumber,
    });
    return OvertimeEmployee.fromApi((data as Map<String, dynamic>)['employee'] as Map<String, dynamic>);
  }

  static Future<OvertimeEmployee> updateEmployee(String id, {required String name, String? employeeNumber}) async {
    final data = await _api.patch('/overtime/employees/$id', {
      'name': name,
      // نص فارغ = مسح الرقم الوظيفي
      'employeeNumber': employeeNumber ?? '',
    });
    return OvertimeEmployee.fromApi((data as Map<String, dynamic>)['employee'] as Map<String, dynamic>);
  }

  static Future<void> deleteEmployee(String id) async {
    await _api.delete('/overtime/employees/$id');
  }

  // ------------------------------- السجلات -------------------------------

  static Future<List<OvertimeRecord>> fetchRecords({required String date}) async {
    final data = await _api.get('/overtime/records', query: {'date': date});
    return _listOf(data, 'records').map((e) => OvertimeRecord.fromApi(e as Map<String, dynamic>)).toList();
  }

  static Map<String, dynamic> _recordBody({
    required String workDate,
    required String workDescription,
    String? reason,
    String? startTime,
    String? endTime,
    String? location,
    String? lines,
    String? product,
    String? batch,
    int? workersCount,
    required List<String> employeeIds,
  }) =>
      {
        'workDate': workDate,
        'workDescription': workDescription,
        'reason': reason,
        'startTime': startTime,
        'endTime': endTime,
        'location': location,
        'lines': lines,
        'product': product,
        'batch': batch,
        'workersCount': workersCount,
        'employeeIds': employeeIds,
      };

  static Future<OvertimeRecord> createRecord({
    required String workDate,
    required String workDescription,
    String? reason,
    String? startTime,
    String? endTime,
    String? location,
    String? lines,
    String? product,
    String? batch,
    int? workersCount,
    required List<String> employeeIds,
  }) async {
    final data = await _api.post(
      '/overtime/records',
      _recordBody(
        workDate: workDate,
        workDescription: workDescription,
        reason: reason,
        startTime: startTime,
        endTime: endTime,
        location: location,
        lines: lines,
        product: product,
        batch: batch,
        workersCount: workersCount,
        employeeIds: employeeIds,
      ),
    );
    return OvertimeRecord.fromApi((data as Map<String, dynamic>)['record'] as Map<String, dynamic>);
  }

  /// تعديل كامل: الحقول غير المُرسَلة (null) تُفرَّغ، وقائمة الأفراد تُستبدل.
  static Future<OvertimeRecord> updateRecord(
    String id, {
    required String workDate,
    required String workDescription,
    String? reason,
    String? startTime,
    String? endTime,
    String? location,
    String? lines,
    String? product,
    String? batch,
    int? workersCount,
    required List<String> employeeIds,
  }) async {
    final data = await _api.patch(
      '/overtime/records/$id',
      _recordBody(
        workDate: workDate,
        workDescription: workDescription,
        reason: reason,
        startTime: startTime,
        endTime: endTime,
        location: location,
        lines: lines,
        product: product,
        batch: batch,
        workersCount: workersCount,
        employeeIds: employeeIds,
      ),
    );
    return OvertimeRecord.fromApi((data as Map<String, dynamic>)['record'] as Map<String, dynamic>);
  }

  static Future<void> deleteRecord(String id) async {
    await _api.delete('/overtime/records/$id');
  }

  // ------------------------------- التقارير -------------------------------

  /// تقرير يوم ('YYYY-MM-DD') أو شهر ('YYYY-MM') — مرّر واحدًا منهما فقط.
  static Future<OvertimeReport> fetchReport({String? date, String? month}) async {
    final query = <String, dynamic>{};
    if (date != null) query['date'] = date;
    if (month != null) query['month'] = month;
    final data = await _api.get('/overtime/report', query: query);
    return OvertimeReport.fromApi(data as Map<String, dynamic>);
  }

  /// كشف فرد واحد: أيام مشاركته وساعات كل يوم — لشهر ('YYYY-MM') أو لسنة
  /// ('YYYY'): مرّر واحدًا منهما فقط.
  static Future<OvertimePersonReport> fetchPersonReport(String employeeId, {String? month, String? year}) async {
    final query = <String, dynamic>{};
    if (month != null) query['month'] = month;
    if (year != null) query['year'] = year;
    final data = await _api.get('/overtime/employees/$employeeId/report', query: query);
    return OvertimePersonReport.fromApi(data as Map<String, dynamic>);
  }

  /// يرسل ملخص التقرير على واتساب: [toGroup] = false لجوال الطالب نفسه،
  /// true لجروب العمل الإضافي/الصيانة.
  static Future<void> sendReportWhatsapp({String? date, String? month, required bool toGroup}) async {
    final body = <String, dynamic>{'target': toGroup ? 'group' : 'me'};
    if (date != null) body['date'] = date;
    if (month != null) body['month'] = month;
    await _api.post('/overtime/report/whatsapp', body);
  }
}
