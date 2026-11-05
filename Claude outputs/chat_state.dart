import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/chat.dart';
import 'api_client.dart';
import 'auth_service.dart';

/// هل يملك هذا الدور الدردشة؟ (حساب "القسم العام" مستثنى — نفس القيد على
/// السيرفر في routes/chat.js: CHAT_EXCLUDED_ROLES).
bool chatAvailableForRole(AppRole? role) => role != null && role != AppRole.general;

/// حالة الدردشة الخاصة بقائمة المحادثات وعدّاد غير المقروء (الشارة الحمراء).
/// مفصولة عمدًا عن AppState (ملف ضخم) — كائن واحد يُنشأ في main.dart ويُشغَّل
/// عند تسجيل الدخول ويُوقَف عند الخروج.
///
/// الرسائل نفسها داخل كل غرفة تُجلب وتُستطلع (Poll) من شاشة الغرفة نفسها، أما
/// هنا فنستطلع قائمة الغرف وإجمالي غير المقروء كل ١٢ ثانية ليظهر العدّاد
/// محدَّثًا على الشاشة الرئيسية بلا فتح الدردشة.
class ChatState extends ChangeNotifier {
  final ApiClient _api = ApiClient.instance;

  List<ChatRoom> rooms = [];
  int unreadTotal = 0;
  bool roomsLoaded = false;
  String? roomsError;

  Timer? _timer;
  bool _running = false;
  bool _refreshing = false;

  /// معرّف الغرفة المفتوحة حاليًا على الشاشة (إن وُجدت) — لا نعرض لها عدّادًا
  /// غير مقروء لأنها تُقرأ فور وصول رسائلها.
  int? openRoomId;

  void start() {
    if (_running) return;
    _running = true;
    refreshRooms();
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 12), (_) => refreshRooms());
  }

  void stop() {
    _running = false;
    _timer?.cancel();
    _timer = null;
    rooms = [];
    unreadTotal = 0;
    roomsLoaded = false;
    roomsError = null;
    openRoomId = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> refreshRooms() async {
    if (!_running || _refreshing) return;
    _refreshing = true;
    try {
      final data = await _api.get('/chat/rooms');
      if (!_running) return; // سُجِّل الخروج أثناء الطلب — نتجاهل الرد القديم
      final list = (data['rooms'] as List).cast<Map<String, dynamic>>();
      rooms = list.map(ChatRoom.fromApi).toList();
      unreadTotal = (data['unread_total'] is num) ? (data['unread_total'] as num).toInt() : 0;
      // الغرفة المفتوحة الآن على الشاشة تُقرأ فور وصول رسائلها — لا نعرض لها
      // عدّادًا (يمنع وميض الشارة بين وصول الرسالة وردّ "تمت القراءة").
      final open = openRoomId;
      if (open != null) {
        rooms = rooms.map((r) => r.id == open ? r.withUnread(0) : r).toList();
        unreadTotal = rooms.fold<int>(0, (sum, r) => sum + r.unreadCount);
      }
      roomsLoaded = true;
      roomsError = null;
      notifyListeners();
    } on ApiException catch (e) {
      if (!_running) return;
      roomsError = e.message;
      roomsLoaded = true;
      notifyListeners();
    } catch (e) {
      if (!_running) return;
      roomsError = 'تعذّر تحميل المحادثات';
      roomsLoaded = true;
      notifyListeners();
    } finally {
      _refreshing = false;
    }
  }

  /// الأشخاص الذين يمكن مراسلتهم (دليل بلا بريد أو جوال).
  Future<List<ChatUser>> fetchUsers() async {
    final data = await _api.get('/chat/users');
    final list = (data['users'] as List).cast<Map<String, dynamic>>();
    return list.map(ChatUser.fromApi).toList();
  }

  /// يفتح (أو ينشئ إن لم توجد) المحادثة الخاصة مع شخص.
  Future<ChatRoom> openDirect(int userId) async {
    final data = await _api.post('/chat/rooms', {'kind': 'direct', 'userId': userId});
    final room = ChatRoom.fromApi(data['room'] as Map<String, dynamic>);
    // ignore: unawaited_futures
    refreshRooms();
    return room;
  }

  Future<ChatRoom> createGroup(String name, List<int> memberIds) async {
    final data = await _api.post('/chat/rooms', {'kind': 'group', 'name': name, 'memberIds': memberIds});
    final room = ChatRoom.fromApi(data['room'] as Map<String, dynamic>);
    // ignore: unawaited_futures
    refreshRooms();
    return room;
  }

  /// تفاصيل الغرفة وأعضاؤها (شاشة معلومات المجموعة).
  Future<ChatRoomDetails> fetchRoomDetails(int roomId) async {
    final data = await _api.get('/chat/rooms/$roomId');
    final room = ChatRoom.fromApi(data['room'] as Map<String, dynamic>);
    final members = (data['members'] as List).cast<Map<String, dynamic>>().map(ChatMember.fromApi).toList();
    return ChatRoomDetails(room: room, members: members);
  }

  /// آخر ٥٠ رسالة، أو الأحدث من [afterId] (استطلاع دوري)، أو الأقدم من
  /// [beforeId] (تحميل المزيد عند التمرير للأعلى). مرتبة من الأقدم للأحدث.
  ///
  /// [checkFrom] (مع [afterId]): اطلب أيضًا معرّفات الرسائل التي حُذفت عند
  /// الجميع منذ هذا المعرّف فصاعدًا، ليحدّث التطبيق ما حمّله مسبقًا.
  Future<ChatMessagesPage> fetchMessages(int roomId, {int? afterId, int? beforeId, int? checkFrom}) async {
    final query = <String, dynamic>{};
    if (afterId != null) query['afterId'] = afterId;
    if (beforeId != null) query['beforeId'] = beforeId;
    if (checkFrom != null) query['checkFrom'] = checkFrom;
    final data = await _api.get('/chat/rooms/$roomId/messages', query: query);
    final list = (data['messages'] as List).cast<Map<String, dynamic>>();
    return ChatMessagesPage(
      messages: list.map(ChatMessage.fromApi).toList(),
      hasMore: data['has_more'] == true,
      readUpTo: (data['read_up_to'] is num) ? (data['read_up_to'] as num).toInt() : 0,
      deletedIds: data['deleted_ids'] is List
          ? (data['deleted_ids'] as List).whereType<num>().map((n) => n.toInt()).toList()
          : <int>[],
    );
  }

  Future<ChatMessage> sendText(int roomId, String text) async {
    final data = await _api.post('/chat/rooms/$roomId/messages', {'kind': 'text', 'body': text});
    // ignore: unawaited_futures
    refreshRooms();
    return ChatMessage.fromApi(data['message'] as Map<String, dynamic>);
  }

  /// [dataUrl] بصيغة data:image/jpeg;base64,... كما تتوقعها نقطة الإرسال.
  Future<ChatMessage> sendImage(int roomId, String dataUrl, {String caption = ''}) async {
    final data = await _api.post('/chat/rooms/$roomId/messages', {
      'kind': 'image',
      'media': dataUrl,
      if (caption.trim().isNotEmpty) 'body': caption.trim(),
    });
    // ignore: unawaited_futures
    refreshRooms();
    return ChatMessage.fromApi(data['message'] as Map<String, dynamic>);
  }

  /// [dataUrl] بصيغة data:audio/mp4;base64,... مع مدة التسجيل بالثواني.
  Future<ChatMessage> sendAudio(int roomId, String dataUrl, int durationSec) async {
    final data = await _api.post('/chat/rooms/$roomId/messages', {
      'kind': 'audio',
      'media': dataUrl,
      'durationSec': durationSec,
    });
    // ignore: unawaited_futures
    refreshRooms();
    return ChatMessage.fromApi(data['message'] as Map<String, dynamic>);
  }

  /// حذف رسالة: [forEveryone] = false → "حذف عندي" (تختفي من شاشتك فقط)،
  /// true → "حذف عند الجميع" (لصاحب الرسالة فقط، يمسح محتواها عند الكل).
  Future<void> deleteMessage(int roomId, int messageId, {required bool forEveryone}) async {
    await _api.delete('/chat/rooms/$roomId/messages/$messageId?scope=${forEveryone ? 'all' : 'me'}');
    // ignore: unawaited_futures
    refreshRooms();
  }

  /// يحدّد المحادثة كمقروءة حتى آخر رسالة، ويُحدّث العدّاد فورًا محليًا.
  Future<void> markRead(int roomId) async {
    try {
      await _api.post('/chat/rooms/$roomId/read', {});
    } catch (_) {
      return;
    }
    var changed = false;
    rooms = rooms.map((r) {
      if (r.id == roomId && r.unreadCount > 0) {
        changed = true;
        return r.withUnread(0);
      }
      return r;
    }).toList();
    if (changed) {
      unreadTotal = rooms.fold<int>(0, (sum, r) => sum + r.unreadCount);
      notifyListeners();
    }
  }

  Future<void> renameGroup(int roomId, String name) async {
    await _api.patch('/chat/rooms/$roomId', {'name': name});
    // ignore: unawaited_futures
    refreshRooms();
  }

  Future<void> addMembers(int roomId, List<int> userIds) async {
    await _api.post('/chat/rooms/$roomId/members', {'userIds': userIds});
    // ignore: unawaited_futures
    refreshRooms();
  }

  /// مغادرة المجموعة (أنت) أو إزالة عضو (للمشرف).
  Future<void> removeMember(int roomId, int userId) async {
    await _api.delete('/chat/rooms/$roomId/members/$userId');
    // ignore: unawaited_futures
    refreshRooms();
  }
}
