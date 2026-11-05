import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'constants.dart';

/// خطأ قادم من سيرفر صيانتي المحلي، مع رسالة عربية جاهزة للعرض مباشرة
/// (السيرفر نفسه يرسل رسائل الخطأ بالعربية ضمن {"error": "..."}).
class ApiException implements Exception {
  final int statusCode;
  final String message;
  ApiException(this.statusCode, this.message);

  /// true لو كان الخطأ بسبب تعذّر الوصول للسيرفر أصلاً (شبكة/رابط خاطئ)،
  /// وليس ردًا فعليًا من السيرفر برمز خطأ.
  bool get isConnectionError => statusCode == 0;

  @override
  String toString() => message;
}

/// عميل REST خفيف (بدون أي حزمة إضافية غير http الموجودة أصلاً) للتواصل مع
/// سيرفر صيانتي المحلي — يحل محل FirestoreRest و FirebaseAuthRest السابقين.
///
/// الفرق الجوهري عن Firebase: هنا رمز الدخول (JWT) طويل الصلاحية (٣٠ يومًا)
/// ولا يحتاج تجديدًا دوريًا كرموز Firebase (التي تنتهي كل ساعة) — لذلك لا
/// حاجة لمنطق "تجديد تلقائي" هنا؛ فقط نسجّل الخروج ونطلب دخولاً جديدًا لو
/// رفض السيرفر الرمز (401)، وهو ما تتولاه AuthService.
class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  static const _tokenPrefKey = 'sayanati_jwt_token';

  String? _token;

  bool get hasToken => _token != null;

  /// قيمة رمز الدخول (JWT) نفسه — تُستخدم فقط لبناء روابط تنزيل مباشرة تُفتح
  /// عبر متصفح خارجي (url_launcher)، مثل تصدير CSV، حيث لا يقدر الرابط
  /// إرسال ترويسة Authorization فيُمرَّر الرمز عبر ?token= بدلًا منها (راجع
  /// تعليق requireAuth في middleware/auth.js على السيرفر). لا يُستخدم لأي
  /// غرض آخر — كل الطلبات العادية تستمر بالترويسة كما هي عبر _headers.
  String? get token => _token;

  /// يُستدعى مرة واحدة عند بدء التطبيق لاسترجاع رمز دخول محفوظ من جلسة سابقة.
  Future<String?> loadPersistedToken() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString(_tokenPrefKey);
    return _token;
  }

  Future<void> setToken(String token) async {
    _token = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenPrefKey, token);
  }

  Future<void> clearToken() async {
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenPrefKey);
  }

  Uri _uri(String path, [Map<String, dynamic>? query]) {
    final full = '$kApiBaseUrl$path';
    final uri = Uri.parse(full);
    if (query == null || query.isEmpty) return uri;
    return uri.replace(queryParameters: {
      ...uri.queryParameters,
      ...query.map((k, v) => MapEntry(k, v.toString())),
    });
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, dynamic>? query,
  }) async {
    final uri = _uri(path, query);
    http.Response res;
    try {
      final encodedBody = body != null ? jsonEncode(body) : null;
      switch (method) {
        case 'GET':
          res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 20));
          break;
        case 'POST':
          res = await http.post(uri, headers: _headers, body: encodedBody).timeout(const Duration(seconds: 20));
          break;
        case 'PATCH':
          res = await http.patch(uri, headers: _headers, body: encodedBody).timeout(const Duration(seconds: 20));
          break;
        case 'PUT':
          res = await http.put(uri, headers: _headers, body: encodedBody).timeout(const Duration(seconds: 20));
          break;
        case 'DELETE':
          res = await http.delete(uri, headers: _headers).timeout(const Duration(seconds: 20));
          break;
        default:
          throw ArgumentError('طريقة HTTP غير مدعومة: $method');
      }
    } catch (_) {
      // يشمل: تعذّر الاتصال، DNS، انتهاء المهلة (Timeout)، أو رابط سيرفر خاطئ
      // في kApiBaseUrl — كلها من منظور المستخدم "لا يوجد اتصال بالسيرفر".
      throw ApiException(0, 'تعذّر الاتصال بسيرفر صيانتي — تحقّقوا من الشبكة، ومن أن السيرفر يعمل، '
          'ومن صحة الرابط في lib/services/constants.dart (kApiBaseUrl).');
    }

    if (res.statusCode == 204) return null;

    dynamic data;
    final raw = utf8.decode(res.bodyBytes);
    if (raw.isNotEmpty) {
      try {
        data = jsonDecode(raw);
      } catch (_) {
        data = null;
      }
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      final message = (data is Map && data['error'] is String)
          ? data['error'] as String
          : 'حدث خطأ غير متوقع من السيرفر (${res.statusCode})';
      throw ApiException(res.statusCode, message);
    }
    return data;
  }

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) => _send('GET', path, query: query);
  Future<dynamic> post(String path, [Map<String, dynamic>? body]) => _send('POST', path, body: body);
  Future<dynamic> patch(String path, [Map<String, dynamic>? body]) => _send('PATCH', path, body: body);
  Future<dynamic> put(String path, [Map<String, dynamic>? body]) => _send('PUT', path, body: body);
  Future<dynamic> delete(String path) => _send('DELETE', path);
}
