import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/chat.dart';
import '../../services/chat_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'chat_room_screen.dart';
import 'chat_widgets.dart';
import 'new_chat_screen.dart';

/// قائمة المحادثات (خاصة ومجموعات) مرتبة بالأحدث، مع شارة غير المقروء لكل
/// محادثة، وزر "محادثة جديدة".
class ChatListScreen extends StatefulWidget {
  const ChatListScreen({super.key});

  @override
  State<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends State<ChatListScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<ChatState>().refreshRooms();
    });
  }

  void _openRoom(ChatRoom room) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatRoomScreen(room: room)));
  }

  void _newChat() {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.person_outline),
              title: const Text('محادثة خاصة'),
              subtitle: const Text('مراسلة شخص واحد'),
              onTap: () {
                Navigator.of(ctx).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const NewChatScreen(mode: ChatPickerMode.direct)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.groups_outlined),
              title: const Text('مجموعة جديدة'),
              subtitle: const Text('محادثة جماعية بعدة أشخاص'),
              onTap: () {
                Navigator.of(ctx).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const NewChatScreen(mode: ChatPickerMode.newGroup)),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<ChatState>();

    Widget body;
    if (!chat.roomsLoaded) {
      body = const Center(child: CircularProgressIndicator());
    } else if (chat.rooms.isEmpty) {
      body = RefreshIndicator(
        onRefresh: () => chat.refreshRooms(),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const SizedBox(height: 120),
            const Icon(Icons.chat_bubble_outline, size: 56, color: AppColors.textFaint),
            const SizedBox(height: 14),
            Text(
              chat.roomsError ?? 'لا توجد محادثات بعد',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
            ),
            const SizedBox(height: 6),
            const Text(
              'اضغط "محادثة جديدة" لمراسلة زميل أو إنشاء مجموعة',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: AppColors.textMuted),
            ),
          ],
        ),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: () => chat.refreshRooms(),
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 90),
          itemCount: chat.rooms.length,
          separatorBuilder: (_, __) => const Divider(height: 1),
          itemBuilder: (context, i) => _RoomTile(room: chat.rooms[i], onTap: () => _openRoom(chat.rooms[i])),
        ),
      );
    }

    return Scaffold(
      appBar: const ScreenTopBar(title: 'الدردشة'),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AppColors.maintenance,
        foregroundColor: Colors.white,
        onPressed: _newChat,
        icon: const Icon(Icons.add_comment_outlined),
        label: const Text('محادثة جديدة'),
      ),
      body: body,
    );
  }
}

class _RoomTile extends StatelessWidget {
  final ChatRoom room;
  final VoidCallback onTap;

  const _RoomTile({required this.room, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final hasUnread = room.unreadCount > 0;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: [
            ChatAvatar(name: room.name, isGroup: room.isGroup),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    room.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    room.previewText,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      color: hasUnread ? AppColors.textPrimary : AppColors.textMuted,
                      fontWeight: hasUnread ? FontWeight.w600 : FontWeight.normal,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  chatListTime(room.lastMessage?.createdAt ?? room.lastMessageAt),
                  style: TextStyle(
                    fontSize: 11,
                    color: hasUnread ? AppColors.maintenance : AppColors.textMuted,
                  ),
                ),
                const SizedBox(height: 6),
                ChatUnreadBadge(count: room.unreadCount),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
