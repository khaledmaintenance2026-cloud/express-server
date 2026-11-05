import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/chat.dart';
import '../../services/api_client.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../services/chat_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'chat_group_info_screen.dart';
import 'chat_widgets.dart';

/// غرفة محادثة (خاصة أو مجموعة): الرسائل (نص، صور، صوت)، الإرسال، وعلامات
/// الإرسال/القراءة. تستطلع (Poll) الرسائل الجديدة كل ٣ ثوانٍ طالما الشاشة
/// مفتوحة، وتحدّد المحادثة كمقروءة تلقائيًا.
///
/// الإرسال فوري في الواجهة: تظهر رسالتك في المحادثة لحظة الضغط على "إرسال"
/// (بعلامة ساعة "جارٍ الإرسال") ثم تتحوّل لرسالة عادية بعلامة ✓ عند ردّ
/// السيرفر؛ لو فشل الإرسال تبقى ظاهرة بعلامة حمراء مع "اضغط لإعادة المحاولة".
/// الرسائل المتتالية تُرسل بالترتيب نفسه (طابور واحد) حتى لا تتبدّل أماكنها.
class ChatRoomScreen extends StatefulWidget {
  final ChatRoom room;

  const ChatRoomScreen({super.key, required this.room});

  @override
  State<ChatRoomScreen> createState() => _ChatRoomScreenState();
}

class _ChatRoomScreenState extends State<ChatRoomScreen> {
  final _textCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  late final ChatState _chat;
  late final int _roomId; // نحتفظ به لإكمال إرسال رسائل الطابور حتى لو غادر المستخدم الشاشة
  late final String _myUid;
  late String _roomName;

  // مرتبة من الأقدم إلى الأحدث
  List<ChatMessage> _messages = [];
  bool _loading = true;
  String? _error;
  bool _hasMore = false;
  bool _loadingMore = false;
  int _readUpTo = 0;

  // آخر معرّف رسالة وصل من السيرفر (يتقدّم من الجلب والاستطلاع فقط، لا من
  // رسائلي المؤكَّدة) — لو استخدمنا آخر عنصر في القائمة لتخطّى الاستطلاع رسالة
  // وصلت من غيري بين آخر استطلاع ورسالتي (id أصغر من id رسالتي).
  int _cursor = 0;
  bool _polling = false;
  Timer? _timer;

  // رسائل قيد الإرسال أو فشل إرسالها (تُعرض أسفل المحادثة قبل أن يردّ السيرفر)
  List<_PendingSend> _pending = [];
  int _inFlight = 0;
  bool _picking = false;
  Future<void> _sendQueue = Future<void>.value();

  @override
  void initState() {
    super.initState();
    _chat = context.read<ChatState>();
    _myUid = context.read<AuthService>().currentUser?.uid ?? '';
    _roomName = widget.room.name;
    _roomId = widget.room.id;
    _chat.openRoomId = widget.room.id;
    _scrollCtrl.addListener(_onScroll);
    _loadInitial();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _poll());
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (_chat.openRoomId == widget.room.id) _chat.openRoomId = null;
    _textCtrl.dispose();
    _scrollCtrl.dispose();
    // ignore: unawaited_futures
    _chat.refreshRooms();
    super.dispose();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _loadInitial() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await _chat.fetchMessages(widget.room.id);
      if (!mounted) return;
      setState(() {
        _messages = page.messages;
        _cursor = page.messages.isEmpty ? 0 : page.messages.last.id;
        _hasMore = page.hasMore;
        _readUpTo = page.readUpTo;
        _loading = false;
      });
      // ignore: unawaited_futures
      _chat.markRead(widget.room.id);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'تعذّر تحميل الرسائل';
        _loading = false;
      });
    }
  }

  Future<void> _poll() async {
    // لا نستطلع أثناء إرسال رسالة: يمنع ظهور رسالتك مرتين لحظة وصولها
    if (_polling || _inFlight > 0 || _loading || _error != null || !mounted) return;
    _polling = true;
    try {
      final lastId = _cursor == 0 ? null : _cursor;
      final firstId = _messages.isEmpty ? null : _messages.first.id;
      final page = lastId == null
          ? await _chat.fetchMessages(widget.room.id)
          : await _chat.fetchMessages(widget.room.id, afterId: lastId, checkFrom: firstId);
      // أُرسلت رسالة أثناء هذا الاستطلاع: نتجاهل نتيجته (قد تحوي نسخة رسالتي من
      // السيرفر قبل ردّ الإرسال فتظهر مرتين) — الاستطلاع التالي يجلبها بلا ضياع.
      if (!mounted || _inFlight > 0) return;
      if (page.messages.isNotEmpty && page.messages.last.id > _cursor) _cursor = page.messages.last.id;
      final existing = _messages.map((m) => m.id).toSet();
      final fresh = page.messages.where((m) => !existing.contains(m.id)).toList();
      // رسائل حمّلناها سابقًا وحذفها صاحبها عند الجميع منذ ذلك الحين
      final deleted = page.deletedIds.toSet();
      final hasNewDeletions = deleted.isNotEmpty && _messages.any((m) => deleted.contains(m.id) && !m.isDeleted);
      if (fresh.isNotEmpty || page.readUpTo != _readUpTo || hasNewDeletions) {
        setState(() {
          final base = hasNewDeletions
              ? _messages.map((m) => deleted.contains(m.id) && !m.isDeleted ? m.markDeleted() : m).toList()
              : _messages;
          // مرتبة بالمعرّف: رسالة وصلت من غيري تقع قبل رسالتي المؤكَّدة لو سبقتها
          _messages = [...base, ...fresh]..sort((a, b) => a.id.compareTo(b.id));
          _readUpTo = page.readUpTo;
        });
      }
      if (fresh.any((m) => !m.isMine(_myUid))) {
        // ignore: unawaited_futures
        _chat.markRead(widget.room.id);
      }
    } catch (_) {
      // أخطاء الاستطلاع المؤقتة (انقطاع شبكة لحظي) لا تُزعج المستخدم — تُعاد المحاولة بعد ٣ ثوانٍ.
    } finally {
      _polling = false;
    }
  }

  void _onScroll() {
    if (!_scrollCtrl.hasClients) return;
    final pos = _scrollCtrl.position;
    if (pos.pixels >= pos.maxScrollExtent - 150) _loadMore();
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore || _messages.isEmpty) return;
    setState(() => _loadingMore = true);
    try {
      final page = await _chat.fetchMessages(widget.room.id, beforeId: _messages.first.id);
      if (!mounted) return;
      final existing = _messages.map((m) => m.id).toSet();
      final older = page.messages.where((m) => !existing.contains(m.id)).toList();
      setState(() {
        _messages = [...older, ..._messages];
        _hasMore = page.hasMore;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollCtrl.hasClients) return;
      _scrollCtrl.animateTo(0, duration: const Duration(milliseconds: 180), curve: Curves.easeOut);
    });
  }

  /// تُظهر الرسالة فورًا في المحادثة ثم تُرسلها للسيرفر بالترتيب.
  void _enqueue(_PendingSend p) {
    setState(() => _pending = [..._pending, p]);
    _scrollToBottom();
    _queueDelivery(p);
  }

  void _queueDelivery(_PendingSend p) {
    _inFlight++;
    _sendQueue = _sendQueue.then((_) => _deliver(p)).whenComplete(() => _inFlight--);
  }

  /// لا ترمي أي استثناء (تلتقط كل الأخطاء) كي لا ينكسر الطابور.
  Future<void> _deliver(_PendingSend p) async {
    // حذف المستخدم الرسالة الفاشلة قبل إعادة المحاولة. لا نتحقق من mounted هنا
    // عمدًا: لو غادر المستخدم الشاشة تُكمل الرسائل المنتظرة إرسالها (لا تضيع).
    if (!_pending.contains(p)) return;
    try {
      final ChatMessage msg;
      if (p.kind == 'image') {
        final bytes = p.imageBytes!;
        final dataUrl = 'data:image/${_detectImageExt(bytes)};base64,${base64Encode(bytes)}';
        msg = await _chat.sendImage(_roomId, dataUrl, caption: p.caption);
      } else {
        msg = await _chat.sendText(_roomId, p.text!);
      }
      if (!mounted) return;
      setState(() {
        _pending = _pending.where((x) => !identical(x, p)).toList();
        if (!_messages.any((m) => m.id == msg.id)) {
          _messages = [..._messages, msg]..sort((a, b) => a.id.compareTo(b.id));
        }
      });
    } on ApiException catch (e) {
      _markFailed(p, e.message);
    } catch (_) {
      _markFailed(p, null);
    }
  }

  void _markFailed(_PendingSend p, String? error) {
    if (!mounted || !_pending.contains(p)) return;
    setState(() {
      p.failed = true;
      p.error = error;
    });
    _toast(error ?? (p.kind == 'image' ? 'تعذّر إرسال الصورة' : 'تعذّر إرسال الرسالة'));
  }

  void _retry(_PendingSend p) {
    if (!p.failed || !_pending.contains(p)) return;
    setState(() {
      p.failed = false;
      p.error = null;
    });
    _queueDelivery(p);
  }

  void _discardPending(_PendingSend p) {
    setState(() => _pending = _pending.where((x) => !identical(x, p)).toList());
  }

  /// قائمة الرسالة الفاشلة: إعادة المحاولة أو حذفها.
  void _showPendingActions(_PendingSend p) {
    if (!p.failed) return;
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.refresh),
              title: const Text('إعادة المحاولة'),
              onTap: () {
                Navigator.of(ctx).pop();
                _retry(p);
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Color(0xFFB3261E)),
              title: const Text('حذف الرسالة', style: TextStyle(color: Color(0xFFB3261E))),
              subtitle: const Text('لم تُرسل أصلًا — تُزال من شاشتك فقط'),
              onTap: () {
                Navigator.of(ctx).pop();
                _discardPending(p);
              },
            ),
          ],
        ),
      ),
    );
  }

  void _sendText() {
    final text = _textCtrl.text.trim();
    if (text.isEmpty) return;
    _textCtrl.clear();
    _enqueue(_PendingSend.text(text));
  }

  // ---------------------------------------------------------------- الصور

  String _detectImageExt(Uint8List bytes) {
    if (bytes.length > 3 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E) return 'png';
    if (bytes.length > 11 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[8] == 0x57 && bytes[9] == 0x45) return 'webp';
    return 'jpeg';
  }

  void _showImageSourceSheet() {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('التقاط صورة بالكاميرا'),
              onTap: () {
                Navigator.of(ctx).pop();
                _pickAndSendImage(ImageSource.camera);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('اختيار من المعرض'),
              onTap: () {
                Navigator.of(ctx).pop();
                _pickAndSendImage(ImageSource.gallery);
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<String?> _askCaption(Uint8List bytes) {
    final ctrl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('إرسال صورة'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: SizedBox(
                  width: double.maxFinite,
                  height: 200,
                  child: Image.memory(bytes, fit: BoxFit.cover),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: ctrl,
                minLines: 1,
                maxLines: 3,
                inputFormatters: [LengthLimitingTextInputFormatter(1000)],
                decoration: fieldDecoration(hint: 'أضف تعليقًا (اختياري)'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('إلغاء')),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text),
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.maintenance, foregroundColor: Colors.white),
            child: const Text('إرسال'),
          ),
        ],
      ),
    );
  }

  Future<void> _pickAndSendImage(ImageSource source) async {
    if (_picking) return;
    _picking = true;
    try {
      final picked = await ImagePicker().pickImage(source: source, maxWidth: 1600, imageQuality: 80);
      if (picked == null) return;
      final bytes = await picked.readAsBytes();
      if (!mounted) return;
      final caption = await _askCaption(bytes);
      if (caption == null || !mounted) return;
      // تظهر الصورة فورًا (بمؤشر "جارٍ الإرسال") ثم تُرفع في الخلفية
      _enqueue(_PendingSend.image(bytes, caption.trim()));
    } catch (_) {
      _toast('تعذّر اختيار الصورة');
    } finally {
      _picking = false;
    }
  }

  // ---------------------------------------------------------------- حذف/نسخ

  void _showMessageActions(ChatMessage m) {
    final copyText = m.isDeleted ? null : m.body;
    final canDeleteForAll = m.isMine(_myUid) && !m.isDeleted && !m.isSystem;
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (copyText != null && copyText.isNotEmpty)
              ListTile(
                leading: const Icon(Icons.copy_outlined),
                title: const Text('نسخ النص'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  Clipboard.setData(ClipboardData(text: copyText));
                  _toast('تم نسخ النص');
                },
              ),
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('حذف عندي'),
              subtitle: const Text('تختفي من شاشتك فقط ويبقى الآخرون يرونها'),
              onTap: () {
                Navigator.of(ctx).pop();
                _deleteForMe(m);
              },
            ),
            if (canDeleteForAll)
              ListTile(
                leading: const Icon(Icons.delete_forever_outlined, color: Color(0xFFB3261E)),
                title: const Text('حذف عند الجميع', style: TextStyle(color: Color(0xFFB3261E))),
                subtitle: const Text('تختفي من عند كل أعضاء المحادثة'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _confirmDeleteForEveryone(m);
                },
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _deleteForMe(ChatMessage m) async {
    try {
      await _chat.deleteMessage(widget.room.id, m.id, forEveryone: false);
      if (!mounted) return;
      setState(() => _messages = _messages.where((x) => x.id != m.id).toList());
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('تعذّر حذف الرسالة');
    }
  }

  Future<void> _confirmDeleteForEveryone(ChatMessage m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف عند الجميع'),
        content: const Text('ستختفي هذه الرسالة من عند كل أعضاء المحادثة ولا يمكن التراجع. هل أنت متأكد؟'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFB3261E), foregroundColor: Colors.white),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await _chat.deleteMessage(widget.room.id, m.id, forEveryone: true);
      if (!mounted) return;
      setState(() => _messages = _messages.map((x) => x.id == m.id ? x.markDeleted() : x).toList());
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('تعذّر حذف الرسالة');
    }
  }

  // ---------------------------------------------------------------- الواجهة

  Future<void> _openInfo() async {
    final left = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ChatGroupInfoScreen(
          room: widget.room,
          onRenamed: (name) {
            if (mounted) setState(() => _roomName = name);
          },
        ),
      ),
    );
    if (left == true && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (_loading) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_error != null) {
      body = Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textSecondary)),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: _loadInitial, child: const Text('إعادة المحاولة')),
            ],
          ),
        ),
      );
    } else if (_messages.isEmpty && _pending.isEmpty) {
      body = const Center(
        child: Text('ابدأ المحادثة بإرسال أول رسالة', style: TextStyle(color: AppColors.textMuted)),
      );
    } else {
      // القائمة معكوسة (الأحدث أسفل): أول العناصر هي الرسائل قيد الإرسال ثم
      // الرسائل المؤكَّدة من السيرفر ثم مؤشر "تحميل الأقدم" في أعلى القائمة.
      final pendingCount = _pending.length;
      body = ListView.builder(
        reverse: true,
        controller: _scrollCtrl,
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        itemCount: pendingCount + _messages.length + (_loadingMore ? 1 : 0),
        itemBuilder: (context, i) {
          if (i < pendingCount) {
            final p = _pending[pendingCount - 1 - i];
            return _MessageBubble(
              message: ChatMessage(
                id: 0,
                roomId: widget.room.id,
                kind: p.kind,
                body: p.kind == 'text' ? p.text : p.caption,
                createdAt: p.createdAt,
              ),
              isMine: true,
              isGroup: widget.room.isGroup,
              isRead: false,
              sendState: p.failed ? _SendState.failed : _SendState.sending,
              localImage: p.imageBytes,
              onTap: p.failed ? () => _showPendingActions(p) : null,
              onLongPress: () => _showPendingActions(p),
            );
          }
          final mi = i - pendingCount;
          if (mi == _messages.length) {
            return const Padding(
              padding: EdgeInsets.all(12),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
            );
          }
          final idx = _messages.length - 1 - mi;
          final msg = _messages[idx];
          final older = idx > 0 ? _messages[idx - 1] : null;
          final showDay = msg.createdAt != null && (older == null ? !_hasMore : !chatSameDay(older.createdAt, msg.createdAt));
          return Column(
            children: [
              if (showDay) _DayChip(label: chatDayLabel(msg.createdAt!)),
              _MessageBubble(
                message: msg,
                isMine: msg.isMine(_myUid),
                isGroup: widget.room.isGroup,
                isRead: msg.id <= _readUpTo,
                onLongPress: () => _showMessageActions(msg),
              ),
            ],
          );
        },
      );
    }

    return Scaffold(
      appBar: ScreenTopBar(
        title: _roomName,
        actions: [
          if (widget.room.isGroup)
            IconButton(
              icon: const Icon(Icons.info_outline),
              tooltip: 'معلومات المجموعة',
              onPressed: _openInfo,
            ),
        ],
      ),
      body: Column(
        children: [
          Expanded(child: body),
          _buildComposer(),
        ],
      ),
    );
  }

  Widget _buildComposer() {
    final hasText = _textCtrl.text.trim().isNotEmpty;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
        decoration: const BoxDecoration(
          color: AppColors.surface,
          border: Border(top: BorderSide(color: AppColors.border)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            IconButton(
              icon: const Icon(Icons.add_photo_alternate_outlined, color: AppColors.textSecondary),
              tooltip: 'إرسال صورة',
              onPressed: _showImageSourceSheet,
            ),
            Expanded(
              child: TextField(
                controller: _textCtrl,
                minLines: 1,
                maxLines: 5,
                textInputAction: TextInputAction.newline,
                inputFormatters: [LengthLimitingTextInputFormatter(4000)],
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  hintText: 'اكتب رسالة...',
                  filled: true,
                  fillColor: AppColors.background,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(22), borderSide: BorderSide.none),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: hasText ? AppColors.maintenance : AppColors.textFaint,
              ),
              child: IconButton(
                icon: const Icon(Icons.send, size: 20, color: Colors.white),
                tooltip: 'إرسال',
                onPressed: hasText ? _sendText : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// رسالة قيد الإرسال أو فشل إرسالها — تُعرض فورًا قبل ردّ السيرفر.
class _PendingSend {
  final String kind; // text | image
  final String? text;
  final Uint8List? imageBytes;
  final String caption;
  final DateTime createdAt = DateTime.now();
  bool failed = false;
  String? error;

  _PendingSend.text(String t)
      : kind = 'text',
        text = t,
        imageBytes = null,
        caption = '';

  _PendingSend.image(Uint8List bytes, this.caption)
      : kind = 'image',
        text = null,
        imageBytes = bytes;
}

enum _SendState { sending, failed }

/// فاصل اليوم بين الرسائل ("اليوم"، "أمس"، أو التاريخ).
class _DayChip extends StatelessWidget {
  final String label;
  const _DayChip({required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(color: AppColors.divider, borderRadius: BorderRadius.circular(999)),
        child: Text(label, style: const TextStyle(fontSize: 11.5, color: AppColors.textSecondary)),
      ),
    );
  }
}

// ألوان أسماء المرسلين في المجموعات (يُختار لون ثابت لكل شخص حسب معرّفه)
const List<Color> _senderColors = [
  Color(0xFF2B3487),
  Color(0xFF1F7A63),
  Color(0xFF6C4BA6),
  Color(0xFFB45309),
  Color(0xFF0E7490),
  Color(0xFFB3261E),
];

class _MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final bool isMine;
  final bool isGroup;
  final bool isRead;
  final VoidCallback onLongPress;

  /// null = رسالة مؤكَّدة من السيرفر. غير ذلك = رسالة محلية قيد الإرسال/فاشلة.
  final _SendState? sendState;

  /// بايتات الصورة المحلية (لمعاينتها فورًا قبل رفعها).
  final Uint8List? localImage;
  final VoidCallback? onTap;

  const _MessageBubble({
    required this.message,
    required this.isMine,
    required this.isGroup,
    required this.isRead,
    required this.onLongPress,
    this.sendState,
    this.localImage,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (message.isSystem) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: GestureDetector(
            onLongPress: onLongPress,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
              decoration: BoxDecoration(color: AppColors.divider, borderRadius: BorderRadius.circular(12)),
              child: Text(
                message.body ?? '',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 11.5, color: AppColors.textSecondary),
              ),
            ),
          ),
        ),
      );
    }

    // 78% من العرض، بحدّ أقصى 560 كي لا تمتد الفقاعة على شاشة الكمبيوتر العريضة
    final maxWidth = (MediaQuery.of(context).size.width * 0.78).clamp(0.0, 560.0).toDouble();
    final textColor = isMine ? Colors.white : AppColors.textPrimary;
    final metaColor = isMine ? Colors.white70 : AppColors.textMuted;
    final senderColor = _senderColors[(message.senderId ?? 0).abs() % _senderColors.length];

    final children = <Widget>[];
    if (isGroup && !isMine && (message.senderName ?? '').isNotEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.only(bottom: 3),
        child: Text(
          message.senderName!,
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: senderColor),
        ),
      ));
    }

    if (message.isDeleted) {
      children.add(Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.block, size: 15, color: metaColor),
          const SizedBox(width: 6),
          Text(
            'تم حذف هذه الرسالة',
            style: TextStyle(fontSize: 13.5, fontStyle: FontStyle.italic, color: metaColor),
          ),
        ],
      ));
    } else if (message.kind == 'image') {
      final url = message.mediaUrl;
      if (localImage != null) {
        children.add(ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Image.memory(localImage!, width: 230, height: 230, fit: BoxFit.cover),
              if (sendState == _SendState.sending)
                Container(
                  width: 230,
                  height: 230,
                  color: Colors.black26,
                  alignment: Alignment.center,
                  child: const SizedBox(
                    width: 26,
                    height: 26,
                    child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white),
                  ),
                ),
            ],
          ),
        ));
      } else if (url != null) {
        children.add(GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(fullscreenDialog: true, builder: (_) => FullScreenPhotoViewer(url: url)),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.network(
              url,
              width: 230,
              height: 230,
              fit: BoxFit.cover,
              loadingBuilder: (context, child, progress) {
                if (progress == null) return child;
                return Container(
                  width: 230,
                  height: 230,
                  color: AppColors.divider,
                  alignment: Alignment.center,
                  child: const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)),
                );
              },
              errorBuilder: (_, __, ___) => Container(
                width: 230,
                height: 120,
                color: AppColors.divider,
                alignment: Alignment.center,
                child: const Icon(Icons.broken_image_outlined, color: AppColors.textMuted),
              ),
            ),
          ),
        ));
      }
      if ((message.body ?? '').isNotEmpty) {
        children.add(Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(message.body!, style: TextStyle(fontSize: 14.5, color: textColor, height: 1.35)),
        ));
      }
    } else if (message.kind == 'audio') {
      children.add(_AudioTile(message: message, isMine: isMine));
    } else {
      children.add(Text(
        message.body ?? '',
        style: TextStyle(fontSize: 14.5, color: textColor, height: 1.35),
      ));
    }

    final time = message.createdAt == null ? '' : ArabicFormat.time(message.createdAt!);
    children.add(Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          Text(
            sendState == _SendState.failed ? 'فشل الإرسال — اضغط لإعادة المحاولة' : time,
            style: TextStyle(
              fontSize: 10,
              color: sendState == _SendState.failed ? const Color(0xFFFFB4AB) : metaColor,
            ),
          ),
          if (isMine && !message.isDeleted) ...[
            const SizedBox(width: 4),
            if (sendState == _SendState.sending)
              const Icon(Icons.schedule, size: 13, color: Colors.white70)
            else if (sendState == _SendState.failed)
              const Icon(Icons.error_outline, size: 14, color: Color(0xFFFFB4AB))
            else
              Icon(
                isRead ? Icons.done_all : Icons.done,
                size: 14,
                color: isRead ? const Color(0xFF8FD3FF) : Colors.white70,
              ),
          ],
        ],
      ),
    ));

    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 3),
          padding: const EdgeInsets.fromLTRB(11, 8, 11, 6),
          constraints: BoxConstraints(maxWidth: maxWidth),
          decoration: BoxDecoration(
            color: isMine ? AppColors.maintenance : AppColors.surface,
            border: isMine ? null : Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: children,
          ),
        ),
      ),
    );
  }
}

/// رسالة صوتية: تفتح الملف في مشغّل الجهاز/المتصفح (المشغّل المدمج داخل
/// التطبيق يُضاف في مرحلة التسجيل الصوتي).
class _AudioTile extends StatelessWidget {
  final ChatMessage message;
  final bool isMine;

  const _AudioTile({required this.message, required this.isMine});

  String get _durationText {
    final s = message.durationSec;
    if (s == null) return '';
    final mm = (s ~/ 60).toString();
    final ss = (s % 60).toString().padLeft(2, '0');
    return ArabicFormat.toEasternDigits('$mm:$ss');
  }

  @override
  Widget build(BuildContext context) {
    final color = isMine ? Colors.white : AppColors.maintenance;
    return InkWell(
      onTap: () async {
        final url = message.mediaUrl;
        if (url == null) return;
        final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        if (!ok && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تعذّر تشغيل الرسالة الصوتية')));
        }
      },
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.play_circle_fill, size: 34, color: color),
          const SizedBox(width: 8),
          Text('رسالة صوتية', style: TextStyle(fontSize: 13.5, color: color, fontWeight: FontWeight.w600)),
          if (_durationText.isNotEmpty) ...[
            const SizedBox(width: 8),
            Text(_durationText, style: TextStyle(fontSize: 12, color: color)),
          ],
        ],
      ),
    );
  }
}
