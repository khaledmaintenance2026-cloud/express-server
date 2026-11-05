import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../models/chat.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../services/chat_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'chat_room_screen.dart';
import 'chat_widgets.dart';

/// ما تفعله شاشة اختيار الأشخاص:
///  - direct: اختيار شخص واحد → تفتح (أو تُنشأ) محادثة خاصة معه.
///  - newGroup: اختيار عدة أشخاص + اسم → تُنشأ مجموعة وتُفتح.
///  - addMembers: اختيار أشخاص لإضافتهم لمجموعة قائمة → تُرجع قائمة المعرّفات
///    (Navigator.pop) لمن استدعاها ليضيفهم.
enum ChatPickerMode { direct, newGroup, addMembers }

class NewChatScreen extends StatefulWidget {
  final ChatPickerMode mode;

  /// معرّفات لا تظهر في القائمة (أعضاء المجموعة الحاليون عند الإضافة).
  final Set<int> excludeIds;

  const NewChatScreen({super.key, required this.mode, this.excludeIds = const {}});

  @override
  State<NewChatScreen> createState() => _NewChatScreenState();
}

class _NewChatScreenState extends State<NewChatScreen> {
  final _searchCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final Set<int> _selected = {};

  List<ChatUser> _users = [];
  bool _loading = true;
  String? _error;
  bool _busy = false;

  bool get _multi => widget.mode != ChatPickerMode.direct;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final users = await context.read<ChatState>().fetchUsers();
      if (!mounted) return;
      setState(() {
        _users = users.where((u) => !widget.excludeIds.contains(u.id)).toList();
        _loading = false;
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
        _error = 'تعذّر تحميل قائمة الأشخاص';
        _loading = false;
      });
    }
  }

  List<ChatUser> get _filtered {
    final q = _searchCtrl.text.trim();
    if (q.isEmpty) return _users;
    return _users.where((u) => u.name.contains(q)).toList();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _openDirect(ChatUser user) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final room = await context.read<ChatState>().openDirect(user.id);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatRoomScreen(room: room)));
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('تعذّر فتح المحادثة');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    if (_selected.isEmpty || _busy) return;
    if (widget.mode == ChatPickerMode.addMembers) {
      Navigator.of(context).pop(_selected.toList());
      return;
    }
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      _toast('اكتب اسم المجموعة أولًا');
      return;
    }
    setState(() => _busy = true);
    try {
      final room = await context.read<ChatState>().createGroup(name, _selected.toList());
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatRoomScreen(room: room)));
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('تعذّر إنشاء المجموعة');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _title {
    switch (widget.mode) {
      case ChatPickerMode.direct:
        return 'محادثة خاصة';
      case ChatPickerMode.newGroup:
        return 'مجموعة جديدة';
      case ChatPickerMode.addMembers:
        return 'إضافة أعضاء';
    }
  }

  String get _submitLabel {
    final n = _selected.length;
    if (widget.mode == ChatPickerMode.addMembers) return n == 0 ? 'اختر أعضاء' : 'إضافة ($n)';
    return n == 0 ? 'اختر الأعضاء' : 'إنشاء المجموعة ($n)';
  }

  @override
  Widget build(BuildContext context) {
    final list = _filtered;

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
              OutlinedButton(onPressed: _load, child: const Text('إعادة المحاولة')),
            ],
          ),
        ),
      );
    } else if (list.isEmpty) {
      body = const Center(
        child: Text('لا يوجد أشخاص مطابقون', style: TextStyle(color: AppColors.textMuted)),
      );
    } else {
      body = ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        itemCount: list.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final u = list[i];
          final roleText = roleLabel(roleFromString(u.role));
          final tile = Row(
            children: [
              ChatAvatar(name: u.name, isGroup: false, size: 42),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(u.name, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(roleText, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  ],
                ),
              ),
              if (_multi)
                Icon(
                  _selected.contains(u.id) ? Icons.check_circle : Icons.radio_button_unchecked,
                  color: _selected.contains(u.id) ? AppColors.maintenance : AppColors.textFaint,
                ),
            ],
          );
          return InkWell(
            onTap: () {
              if (_multi) {
                setState(() {
                  if (!_selected.add(u.id)) _selected.remove(u.id);
                });
              } else {
                _openDirect(u);
              }
            },
            child: Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: tile),
          );
        },
      );
    }

    return Scaffold(
      appBar: ScreenTopBar(title: _title),
      body: Column(
        children: [
          if (widget.mode == ChatPickerMode.newGroup)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: TextField(
                controller: _nameCtrl,
                inputFormatters: [LengthLimitingTextInputFormatter(60)],
                decoration: fieldDecoration(hint: 'اسم المجموعة (مثال: فريق الصيانة)'),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: TextField(
              controller: _searchCtrl,
              onChanged: (_) => setState(() {}),
              decoration: fieldDecoration(hint: 'بحث بالاسم').copyWith(prefixIcon: const Icon(Icons.search, size: 20)),
            ),
          ),
          Expanded(child: body),
          if (_multi)
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: PrimaryButton(
                  label: _busy ? 'جارٍ التنفيذ...' : _submitLabel,
                  color: AppColors.maintenance,
                  onPressed: (_selected.isEmpty || _busy) ? null : _submit,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
