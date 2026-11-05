import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../models/chat.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../services/chat_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'chat_widgets.dart';
import 'new_chat_screen.dart';

/// معلومات المجموعة: الأعضاء، تغيير الاسم وإضافة/إزالة الأعضاء (للمشرف)،
/// ومغادرة المجموعة. تُرجع true (Navigator.pop) لو غادر المستخدم المجموعة
/// ليُغلق معها شاشة الغرفة.
class ChatGroupInfoScreen extends StatefulWidget {
  final ChatRoom room;
  final ValueChanged<String>? onRenamed;

  const ChatGroupInfoScreen({super.key, required this.room, this.onRenamed});

  @override
  State<ChatGroupInfoScreen> createState() => _ChatGroupInfoScreenState();
}

class _ChatGroupInfoScreenState extends State<ChatGroupInfoScreen> {
  late final ChatState _chat;
  late final int _myId;
  ChatRoom? _room;
  List<ChatMember> _members = [];
  bool _loading = true;
  String? _error;
  bool _busy = false;

  bool get _iAmAdmin => _room?.isAdmin ?? widget.room.isAdmin;

  @override
  void initState() {
    super.initState();
    _chat = context.read<ChatState>();
    _myId = int.tryParse(context.read<AuthService>().currentUser?.uid ?? '') ?? 0;
    _load();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _load() async {
    try {
      final details = await _chat.fetchRoomDetails(widget.room.id);
      if (!mounted) return;
      setState(() {
        _room = details.room;
        _members = details.members;
        _loading = false;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'تعذّر تحميل معلومات المجموعة';
        _loading = false;
      });
    }
  }

  Future<void> _run(Future<void> Function() action, String failMessage) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast(failMessage);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _rename() async {
    final ctrl = TextEditingController(text: _room?.name ?? widget.room.name);
    final newName = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تغيير اسم المجموعة'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          inputFormatters: [LengthLimitingTextInputFormatter(60)],
          decoration: fieldDecoration(hint: 'اسم المجموعة'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('إلغاء')),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.maintenance, foregroundColor: Colors.white),
            child: const Text('حفظ'),
          ),
        ],
      ),
    );
    if (newName == null || newName.isEmpty || newName == (_room?.name ?? widget.room.name)) return;
    await _run(() async {
      await _chat.renameGroup(widget.room.id, newName);
      widget.onRenamed?.call(newName);
      await _load();
    }, 'تعذّر تغيير الاسم');
  }

  Future<void> _addMembers() async {
    final ids = await Navigator.of(context).push<List<int>>(
      MaterialPageRoute(
        builder: (_) => NewChatScreen(
          mode: ChatPickerMode.addMembers,
          excludeIds: _members.map((m) => m.userId).toSet(),
        ),
      ),
    );
    if (ids == null || ids.isEmpty) return;
    await _run(() async {
      await _chat.addMembers(widget.room.id, ids);
      await _load();
    }, 'تعذّر إضافة الأعضاء');
  }

  Future<bool> _confirm(String title, String message, String confirmLabel) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFB3261E), foregroundColor: Colors.white),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _removeMember(ChatMember member) async {
    final ok = await _confirm('إزالة عضو', 'هل تريد إزالة ${member.name} من المجموعة؟', 'إزالة');
    if (!ok) return;
    await _run(() async {
      await _chat.removeMember(widget.room.id, member.userId);
      await _load();
    }, 'تعذّرت إزالة العضو');
  }

  Future<void> _leave() async {
    final ok = await _confirm('مغادرة المجموعة', 'لن تصلك رسائل هذه المجموعة بعد المغادرة. هل أنت متأكد؟', 'مغادرة');
    if (!ok) return;
    await _run(() async {
      await _chat.removeMember(widget.room.id, _myId);
      if (mounted) Navigator.of(context).pop(true);
    }, 'تعذّرت المغادرة');
  }

  @override
  Widget build(BuildContext context) {
    final name = _room?.name ?? widget.room.name;

    Widget body;
    if (_loading) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_error != null) {
      body = Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textSecondary)),
        ),
      );
    } else {
      body = ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          Center(child: ChatAvatar(name: name, isGroup: true, size: 78)),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Flexible(
                child: Text(
                  name,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold),
                ),
              ),
              if (_iAmAdmin)
                IconButton(
                  icon: const Icon(Icons.edit_outlined, size: 19),
                  tooltip: 'تغيير الاسم',
                  onPressed: _busy ? null : _rename,
                ),
            ],
          ),
          Text(
            '${_members.length} عضو',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
          ),
          const SizedBox(height: 18),
          if (_iAmAdmin)
            OutlinedButton.icon(
              onPressed: _busy ? null : _addMembers,
              icon: const Icon(Icons.person_add_alt_1_outlined, size: 19),
              label: const Text('إضافة أعضاء'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.maintenance,
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          const SizedBox(height: 14),
          const Text('الأعضاء', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
          const SizedBox(height: 6),
          for (final m in _members) _memberRow(m),
          const SizedBox(height: 18),
          TextButton.icon(
            onPressed: _busy ? null : _leave,
            icon: const Icon(Icons.logout, size: 19),
            label: const Text('مغادرة المجموعة'),
            style: TextButton.styleFrom(foregroundColor: const Color(0xFFB3261E)),
          ),
        ],
      );
    }

    return Scaffold(
      appBar: const ScreenTopBar(title: 'معلومات المجموعة'),
      body: body,
    );
  }

  Widget _memberRow(ChatMember m) {
    final isMe = m.userId == _myId;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          ChatAvatar(name: m.name, isGroup: false, size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isMe ? '${m.name} (أنت)' : m.name,
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(roleLabel(roleFromString(m.role)), style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ),
          ),
          if (m.isAdmin)
            const StatusPill(label: 'مشرف', color: AppColors.successText, background: AppColors.successBg),
          if (_iAmAdmin && !isMe)
            IconButton(
              icon: const Icon(Icons.person_remove_outlined, size: 20, color: AppColors.textMuted),
              tooltip: 'إزالة من المجموعة',
              onPressed: _busy ? null : () => _removeMember(m),
            ),
        ],
      ),
    );
  }
}
