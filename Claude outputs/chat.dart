import '../services/constants.dart';

/// نماذج الدردشة داخل التطبيق (محادثات خاصة + مجموعات) — تقابل ردود
/// routes/chat.js على السيرفر مباشرة. الأرقام قد تصل من السيرفر كأرقام أو
/// كنصوص (BIGINT)، لذلك كل القراءات تمر عبر الدالتين التاليتين.

int _asInt(Object? v) {
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? 0;
  return 0;
}

DateTime? _asDate(Object? v) {
  if (v is String) return DateTime.tryParse(v)?.toLocal();
  return null;
}

/// شخص من دليل الدردشة (قائمة اختيار من تريد مراسلته) — الاسم والدور فقط.
class ChatUser {
  final int id;
  final String name;
  final String role;

  const ChatUser({required this.id, required this.name, required this.role});

  factory ChatUser.fromApi(Map<String, dynamic> j) => ChatUser(
        id: _asInt(j['id']),
        name: (j['name'] ?? '') as String,
        role: (j['role'] ?? '') as String,
      );
}

/// أحدث رسالة في المحادثة — تُعرض كمعاينة في قائمة المحادثات.
class ChatLastMessage {
  final int id;
  final String kind; // text | image | audio | system
  final String? body;
  final bool deleted; // حُذفت عند الجميع
  final int? senderId;
  final String? senderName;
  final DateTime? createdAt;

  const ChatLastMessage({
    required this.id,
    required this.kind,
    this.body,
    this.deleted = false,
    this.senderId,
    this.senderName,
    this.createdAt,
  });

  factory ChatLastMessage.fromApi(Map<String, dynamic> j) => ChatLastMessage(
        id: _asInt(j['id']),
        kind: (j['kind'] ?? 'text') as String,
        body: j['body'] as String?,
        deleted: j['deleted'] == true,
        senderId: j['sender_id'] == null ? null : _asInt(j['sender_id']),
        senderName: j['sender_name'] as String?,
        createdAt: _asDate(j['created_at']),
      );
}

/// محادثة (خاصة بين شخصين أو مجموعة).
class ChatRoom {
  final int id;
  final String kind; // direct | group
  final String name; // للمحادثة الخاصة = اسم الطرف الآخر
  final int? otherUserId;
  final bool isAdmin;
  final int memberCount;
  final int unreadCount;
  final ChatLastMessage? lastMessage;
  final DateTime? lastMessageAt;

  const ChatRoom({
    required this.id,
    required this.kind,
    required this.name,
    this.otherUserId,
    this.isAdmin = false,
    this.memberCount = 0,
    this.unreadCount = 0,
    this.lastMessage,
    this.lastMessageAt,
  });

  bool get isGroup => kind == 'group';

  /// نسخة من الغرفة بعدّاد غير مقروء مختلف (يُستخدم لتصفير العدّاد محليًا فور
  /// فتح المحادثة بدل انتظار الرد التالي من السيرفر).
  ChatRoom withUnread(int count) => ChatRoom(
        id: id,
        kind: kind,
        name: name,
        otherUserId: otherUserId,
        isAdmin: isAdmin,
        memberCount: memberCount,
        unreadCount: count,
        lastMessage: lastMessage,
        lastMessageAt: lastMessageAt,
      );

  factory ChatRoom.fromApi(Map<String, dynamic> j) {
    final last = j['last_message'];
    return ChatRoom(
      id: _asInt(j['id']),
      kind: (j['kind'] ?? 'direct') as String,
      name: (j['name'] ?? '') as String,
      otherUserId: j['other_user_id'] == null ? null : _asInt(j['other_user_id']),
      isAdmin: j['is_admin'] == true,
      memberCount: _asInt(j['member_count']),
      unreadCount: _asInt(j['unread_count']),
      lastMessage: last is Map<String, dynamic> ? ChatLastMessage.fromApi(last) : null,
      lastMessageAt: _asDate(j['last_message_at']),
    );
  }

  /// معاينة نصية قصيرة لآخر رسالة (للقائمة).
  String get previewText {
    final m = lastMessage;
    if (m == null) return 'لا توجد رسائل بعد';
    if (m.deleted) return 'تم حذف هذه الرسالة';
    String text;
    switch (m.kind) {
      case 'image':
        text = (m.body != null && m.body!.isNotEmpty) ? 'صورة: ${m.body}' : 'صورة';
        break;
      case 'audio':
        text = 'رسالة صوتية';
        break;
      default:
        text = m.body ?? '';
    }
    // في المجموعات نذكر اسم المرسل، إلا رسائل النظام (إضافة/مغادرة...)
    if (isGroup && m.kind != 'system' && m.senderName != null && m.senderName!.isNotEmpty) {
      return '${m.senderName}: $text';
    }
    return text;
  }
}

/// رسالة داخل محادثة.
class ChatMessage {
  final int id;
  final int roomId;
  final int? senderId;
  final String? senderName;
  final String kind; // text | image | audio | system
  final String? body;
  final String? mediaPath;
  final int? durationSec;
  final DateTime? createdAt;

  /// وقت الحذف عند الجميع — لو غير null تُعرض الرسالة كأثر "تم حذف هذه الرسالة"
  /// بلا محتواها (السيرفر يمسح النص/الصورة/الصوت عند الحذف).
  final DateTime? deletedAt;

  const ChatMessage({
    required this.id,
    required this.roomId,
    this.senderId,
    this.senderName,
    required this.kind,
    this.body,
    this.mediaPath,
    this.durationSec,
    this.createdAt,
    this.deletedAt,
  });

  factory ChatMessage.fromApi(Map<String, dynamic> j) => ChatMessage(
        id: _asInt(j['id']),
        roomId: _asInt(j['room_id']),
        senderId: j['sender_id'] == null ? null : _asInt(j['sender_id']),
        senderName: j['sender_name'] as String?,
        kind: (j['kind'] ?? 'text') as String,
        body: j['body'] as String?,
        mediaPath: j['media_path'] as String?,
        durationSec: j['duration_sec'] == null ? null : _asInt(j['duration_sec']),
        createdAt: _asDate(j['created_at']),
        deletedAt: _asDate(j['deleted_at']),
      );

  bool get isSystem => kind == 'system';

  bool get isDeleted => deletedAt != null;

  /// نسخة من الرسالة بعد "حذف عند الجميع": يبقى المرسل والوقت فقط.
  ChatMessage markDeleted() => ChatMessage(
        id: id,
        roomId: roomId,
        senderId: senderId,
        senderName: senderName,
        kind: kind,
        createdAt: createdAt,
        deletedAt: DateTime.now(),
      );

  /// رابط كامل لملف الصورة/الصوت المحفوظ على السيرفر (يُخزَّن كمسار نسبي).
  String? get mediaUrl {
    final p = mediaPath;
    if (p == null || p.isEmpty) return null;
    return p.startsWith('http') ? p : '$kApiOrigin$p';
  }

  bool isMine(String myUid) => senderId != null && senderId.toString() == myUid;
}

/// عضو في مجموعة.
class ChatMember {
  final int userId;
  final String name;
  final String role;
  final bool isAdmin;

  const ChatMember({required this.userId, required this.name, required this.role, required this.isAdmin});

  factory ChatMember.fromApi(Map<String, dynamic> j) => ChatMember(
        userId: _asInt(j['user_id']),
        name: (j['name'] ?? '') as String,
        role: (j['role'] ?? '') as String,
        isAdmin: j['is_admin'] == true,
      );
}

/// نتيجة جلب رسائل غرفة.
class ChatMessagesPage {
  final List<ChatMessage> messages;
  final bool hasMore;
  final int readUpTo;

  /// معرّفات رسائل حُذفت عند الجميع (تأتي مع الاستطلاع الدوري فقط).
  final List<int> deletedIds;

  const ChatMessagesPage({
    required this.messages,
    required this.hasMore,
    required this.readUpTo,
    this.deletedIds = const [],
  });
}

/// تفاصيل غرفة مع قائمة أعضائها (شاشة معلومات المجموعة).
class ChatRoomDetails {
  final ChatRoom room;
  final List<ChatMember> members;

  const ChatRoomDetails({required this.room, required this.members});
}
