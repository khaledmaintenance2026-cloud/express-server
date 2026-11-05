import 'package:flutter/material.dart';

import '../../models/overtime.dart';
import '../../services/api_client.dart';
import '../../theme/app_theme.dart';

/// لون تبويب "العمل الإضافي" (كهرماني داكن) ولون الخطر المستعمل في الحذف.
const Color kOvertimeColor = AppColors.warningText;
const Color kOvertimeDanger = Color(0xFFB3261E);

/// عدّاد تغيّر بيانات العمل الإضافي (سجل أو فرد). أي شاشة تعدّل شيئًا تستدعي
/// [notifyOvertimeChanged]، فتعيد الشاشات المفتوحة (السجل اليومي مثلًا، وهو
/// محفوظ الحالة عند التنقل بين التبويبات) تحميل بياناتها تلقائيًا.
final ValueNotifier<int> overtimeChanged = ValueNotifier<int>(0);

void notifyOvertimeChanged() {
  overtimeChanged.value = overtimeChanged.value + 1;
}

/// نص خطأ جاهز للعرض: رسالة السيرفر العربية لو وُجدت، وإلا رسالة عامة.
String overtimeErrorText(Object error) {
  if (error is ApiException) return error.message;
  return 'تعذّر تنفيذ الطلب، تأكد من اتصال الإنترنت ثم حاول مرة أخرى';
}

void showOvertimeSnack(BuildContext context, String message, {bool error = false}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(
    SnackBar(content: Text(message), backgroundColor: error ? kOvertimeDanger : null),
  );
}

/// سهم لا ينعكس باتجاه النص (لتبقى أسهم التنقل السابق/التالي واضحة في RTL).
Widget _fixedArrow(IconData icon) =>
    Directionality(textDirection: TextDirection.ltr, child: Icon(icon, color: kOvertimeColor));

/// شريط التنقل بين الأيام/الشهور: السابق على اليمين، التالي على اليسار (اتجاه
/// القراءة العربي)، وضغطة على الوسط تفتح اختيار التاريخ.
class OvertimePeriodBar extends StatelessWidget {
  final String title;
  final String? subtitle;
  final VoidCallback onPrevious;
  final VoidCallback onNext;
  final VoidCallback? onTap;

  const OvertimePeriodBar({
    super.key,
    required this.title,
    this.subtitle,
    required this.onPrevious,
    required this.onNext,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          IconButton(tooltip: 'السابق', onPressed: onPrevious, icon: _fixedArrow(Icons.chevron_right)),
          Expanded(
            child: InkWell(
              onTap: onTap,
              borderRadius: BorderRadius.circular(10),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (onTap != null) ...[
                          const Icon(Icons.calendar_month_outlined, size: 18, color: kOvertimeColor),
                          const SizedBox(width: 8),
                        ],
                        Flexible(
                          child: Text(
                            title,
                            textAlign: TextAlign.center,
                            style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ],
                    ),
                    if (subtitle != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(subtitle!, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                      ),
                  ],
                ),
              ),
            ),
          ),
          IconButton(tooltip: 'التالي', onPressed: onNext, icon: _fixedArrow(Icons.chevron_left)),
        ],
      ),
    );
  }
}

/// خانة معلومة صغيرة (أيقونة + نص) تُستعمل لعرض الموقع/الخط/المنتج… داخل
/// بطاقة السجل.
class OvertimeInfoChip extends StatelessWidget {
  final IconData icon;
  final String text;
  final Color? color;

  const OvertimeInfoChip({super.key, required this.icon, required this.text, this.color});

  @override
  Widget build(BuildContext context) {
    final c = color ?? AppColors.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(color: AppColors.background, borderRadius: BorderRadius.circular(8)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: c),
          const SizedBox(width: 5),
          Flexible(child: Text(text, style: TextStyle(fontSize: 12, color: c))),
        ],
      ),
    );
  }
}

/// عنوان قسم صغير.
class OvertimeSectionTitle extends StatelessWidget {
  final String text;
  const OvertimeSectionTitle(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 8),
      child: Align(
        alignment: Alignment.centerRight,
        child: Text(
          text,
          style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
        ),
      ),
    );
  }
}

/// بطاقة سجل عمل إضافي واحد: العمل، السبب، المعلومات المعبّأة فقط، وأسماء
/// الأفراد. أزرار التعديل والحذف تظهر فقط لو مُرّرت دوالها (السجل اليومي) —
/// وبدونها تكون البطاقة للعرض فقط (التقارير).
class OvertimeRecordCard extends StatelessWidget {
  final OvertimeRecord record;
  final int? number;
  final bool showDate;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;

  const OvertimeRecordCard({
    super.key,
    required this.record,
    this.number,
    this.showDate = false,
    this.onEdit,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final r = record;
    final chips = <Widget>[];
    if (r.location != null) chips.add(OvertimeInfoChip(icon: Icons.place_outlined, text: r.location!));
    if (r.lines != null) chips.add(OvertimeInfoChip(icon: Icons.linear_scale, text: 'الخطوط: ${r.lines}'));
    if (r.product != null) chips.add(OvertimeInfoChip(icon: Icons.inventory_2_outlined, text: r.product!));
    if (r.batch != null) chips.add(OvertimeInfoChip(icon: Icons.tag, text: 'باتش ${r.batch}'));
    final workers = (r.workersCount != null && r.workersCount! > 0) ? r.workersCount! : r.employeesCount;
    if (workers > 0) {
      chips.add(OvertimeInfoChip(icon: Icons.groups_outlined, text: '${overtimeCount(workers)} عامل'));
    }
    if (r.startTime != null && r.endTime != null) {
      chips.add(OvertimeInfoChip(
        icon: Icons.schedule,
        text: 'من ${overtimeTimeLabel(r.startTime!)} إلى ${overtimeTimeLabel(r.endTime!)}',
      ));
      if (r.hours != null) {
        chips.add(OvertimeInfoChip(icon: Icons.timer_outlined, text: overtimeHoursLabel(r.hours!), color: kOvertimeColor));
      }
    }

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (number != null) ...[
                CircleAvatar(
                  radius: 13,
                  backgroundColor: kOvertimeColor.withOpacity(0.12),
                  child: Text(
                    overtimeCount(number!),
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: kOvertimeColor),
                  ),
                ),
                const SizedBox(width: 10),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(r.workDescription, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold, height: 1.5)),
                    if (showDate)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          '${overtimeDateLabel(r.workDate)}${_weekdaySuffix(r.workDate)}',
                          style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                        ),
                      ),
                  ],
                ),
              ),
              if (onEdit != null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: 'تعديل',
                  icon: const Icon(Icons.edit_outlined, size: 20, color: AppColors.textMuted),
                  onPressed: onEdit,
                ),
              if (onDelete != null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: 'حذف',
                  icon: const Icon(Icons.delete_outline, size: 20, color: kOvertimeDanger),
                  onPressed: onDelete,
                ),
            ],
          ),
          if (r.reason != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              decoration: BoxDecoration(color: const Color(0xFFFFF8E6), borderRadius: BorderRadius.circular(10)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('سبب العمل الإضافي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: kOvertimeColor)),
                  const SizedBox(height: 2),
                  Text(r.reason!, style: const TextStyle(fontSize: 13, height: 1.5)),
                ],
              ),
            ),
          ],
          if (chips.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: chips),
          ],
          const SizedBox(height: 10),
          Text(
            'الأفراد (${overtimeCount(r.entries.length)})',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 6),
          if (r.entries.isEmpty)
            const Text('لم يُحدَّد أفراد لهذا العمل', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted))
          else
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: r.entries
                  .map(
                    (e) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: kOvertimeColor.withOpacity(0.08),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        e.employeeNumber == null ? e.name : '${e.name} (${overtimeNumberLabel(e.employeeNumber!)})',
                        style: const TextStyle(fontSize: 12, color: AppColors.textPrimary),
                      ),
                    ),
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  static String _weekdaySuffix(String iso) {
    final d = overtimeParseDate(iso);
    return d == null ? '' : ' — ${overtimeWeekdayName(d)}';
  }
}

/// حالة "لا توجد بيانات" بأيقونة ونص.
class OvertimeEmptyState extends StatelessWidget {
  final IconData icon;
  final String text;

  const OvertimeEmptyState({super.key, required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 24),
      child: Column(
        children: [
          Icon(icon, size: 46, color: AppColors.textFaint),
          const SizedBox(height: 12),
          Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13.5, color: AppColors.textMuted, height: 1.6),
          ),
        ],
      ),
    );
  }
}

/// حالة الخطأ مع زر "إعادة المحاولة".
class OvertimeErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const OvertimeErrorView({super.key, required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 24),
      child: Column(
        children: [
          const Icon(Icons.error_outline, size: 44, color: kOvertimeDanger),
          const SizedBox(height: 12),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13.5, color: AppColors.textSecondary, height: 1.6),
          ),
          const SizedBox(height: 14),
          OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('إعادة المحاولة'),
            style: OutlinedButton.styleFrom(foregroundColor: kOvertimeColor, side: const BorderSide(color: kOvertimeColor)),
          ),
        ],
      ),
    );
  }
}
