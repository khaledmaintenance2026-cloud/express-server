import 'package:flutter/material.dart';

import '../../services/arabic_format.dart';
import '../../theme/app_theme.dart';

/// أدوات عرض مشتركة بين شاشات الدردشة (الصورة الرمزية، الشارة، تنسيق الوقت).

/// دائرة بحرف الاسم الأول (محادثة خاصة) أو أيقونة مجموعة.
class ChatAvatar extends StatelessWidget {
  final String name;
  final bool isGroup;
  final double size;

  const ChatAvatar({super.key, required this.name, required this.isGroup, this.size = 46});

  @override
  Widget build(BuildContext context) {
    final trimmed = name.trim();
    final letter = trimmed.isEmpty ? '؟' : String.fromCharCode(trimmed.runes.first);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: isGroup ? AppColors.production.withOpacity(0.14) : AppColors.maintenance.withOpacity(0.12),
      ),
      child: isGroup
          ? Icon(Icons.groups_outlined, size: size * 0.52, color: AppColors.production)
          : Text(
              letter,
              style: TextStyle(fontSize: size * 0.42, fontWeight: FontWeight.bold, color: AppColors.maintenance),
            ),
    );
  }
}

/// شارة حمراء بعدد الرسائل غير المقروءة.
class ChatUnreadBadge extends StatelessWidget {
  final int count;
  const ChatUnreadBadge({super.key, required this.count});

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      constraints: const BoxConstraints(minWidth: 20),
      decoration: BoxDecoration(color: const Color(0xFFB3261E), borderRadius: BorderRadius.circular(10)),
      child: Text(
        count > 99 ? '٩٩+' : ArabicFormat.toEasternDigits(count),
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 11, color: Colors.white, fontWeight: FontWeight.bold),
      ),
    );
  }
}

bool _sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;

/// وقت آخر رسالة في قائمة المحادثات: الساعة لو اليوم، "أمس"، أو التاريخ.
String chatListTime(DateTime? t) {
  if (t == null) return '';
  final now = DateTime.now();
  if (_sameDay(t, now)) return ArabicFormat.time(t);
  if (_sameDay(t, now.subtract(const Duration(days: 1)))) return 'أمس';
  return ArabicFormat.date(t);
}

/// عنوان الفاصل بين أيام الرسائل داخل الغرفة.
String chatDayLabel(DateTime t) {
  final now = DateTime.now();
  if (_sameDay(t, now)) return 'اليوم';
  if (_sameDay(t, now.subtract(const Duration(days: 1)))) return 'أمس';
  return ArabicFormat.date(t);
}

bool chatSameDay(DateTime? a, DateTime? b) {
  if (a == null || b == null) return false;
  return _sameDay(a, b);
}
