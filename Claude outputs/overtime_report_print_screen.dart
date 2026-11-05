import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../../models/overtime.dart';
import '../../services/html_report_opener.dart';
import '../../services/overtime_report_html.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_widgets.dart';

/// تقرير العمل الإضافي (يوم أو شهر) كملف PDF قابل للطباعة والمشاركة — نفس
/// آلية تقرير بلاغ الصيانة (maintenance_report_print_screen.dart):
///
/// • أندرويد: يُبنى التقرير كـ HTML ثم يتحول إلى PDF عبر Printing.convertHtml
///   (يعتمد على مكوّن Android System WebView)، مع مهلة 20 ثانية ورسالة واضحة
///   بدل تحميل لا ينتهي.
/// • ويب: convertHtml غير مدعوم، فنفتح التقرير في تبويب متصفح جديد ليطبعه
///   المستخدم أو يحفظه PDF بخاصية الطباعة في المتصفح (Ctrl+P).
class OvertimeReportPrintScreen extends StatefulWidget {
  /// تقرير يوم/شهر/مدة — أو null لو كان المطلوب كشف فرد واحد ([person]).
  final OvertimeReport? report;

  /// كشف فرد واحد (أيامه وساعات كل يوم) — أو null لو كان المطلوب [report].
  final OvertimePersonReport? person;

  const OvertimeReportPrintScreen({super.key, required OvertimeReport report})
      : report = report,
        person = null;

  const OvertimeReportPrintScreen.person({super.key, required OvertimePersonReport person})
      : person = person,
        report = null;

  @override
  State<OvertimeReportPrintScreen> createState() => _OvertimeReportPrintScreenState();
}

class _OvertimeReportPrintScreenState extends State<OvertimeReportPrintScreen> {
  bool _timedOut = false;
  int _attempt = 0;
  late final String _html = _buildHtml();

  String _buildHtml() {
    final person = widget.person;
    if (person != null) return buildOvertimePersonReportHtml(person);
    return buildOvertimeReportHtml(widget.report!);
  }

  String get _fileName {
    final person = widget.person;
    if (person != null) return 'overtime_person_${person.employee.id}_${person.from}_to_${person.to}.pdf';
    final r = widget.report!;
    return r.mode == 'day' ? 'overtime_${r.from}.pdf' : 'overtime_${r.from}_to_${r.to}.pdf';
  }

  Future<Uint8List> _build(dynamic format) async {
    try {
      final bytes = await Printing.convertHtml(format: format, html: _html).timeout(const Duration(seconds: 20));
      return bytes;
    } on TimeoutException {
      if (mounted) setState(() => _timedOut = true);
      rethrow;
    }
  }

  void _retry() => setState(() {
        _timedOut = false;
        _attempt++;
      });

  void _openOnWeb() {
    final opened = openHtmlReportInNewTab(_html);
    if (!opened && mounted) {
      showOvertimeSnack(context, 'منع المتصفح فتح التبويب الجديد — اسمح للموقع بالنوافذ المنبثقة ثم أعد المحاولة', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ScreenTopBar(title: widget.person != null ? 'كشف الفرد' : 'تقرير العمل الإضافي'),
      body: kIsWeb
          ? _WebPrintView(onOpen: _openOnWeb)
          : (_timedOut
              ? _ConversionTimeoutView(onRetry: _retry)
              : PdfPreview(
                  key: ValueKey(_attempt),
                  build: _build,
                  allowSharing: true,
                  allowPrinting: true,
                  canChangeOrientation: false,
                  canChangePageFormat: false,
                  pdfFileName: _fileName,
                  loadingWidget: const Center(child: CircularProgressIndicator(color: kOvertimeColor)),
                )),
    );
  }
}

/// على الويب: زر يفتح التقرير في تبويب جديد للطباعة/الحفظ كـ PDF.
class _WebPrintView extends StatelessWidget {
  final VoidCallback onOpen;
  const _WebPrintView({required this.onOpen});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.picture_as_pdf_outlined, size: 48, color: kOvertimeColor),
            const SizedBox(height: 16),
            const Text(
              'التقرير جاهز للفتح',
              style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),
            const Text(
              'اضغط الزر بالأسفل لفتح التقرير في تبويب جديد، ثم استخدم خاصية '
              'الطباعة في المتصفح (Ctrl+P) واختر "حفظ كـ PDF" لحفظه، '
              'أو اختر طابعتك للطباعة مباشرة.',
              style: TextStyle(fontSize: 13, color: AppColors.textMuted, height: 1.6),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            PrimaryButton(label: 'فتح التقرير', color: kOvertimeColor, icon: Icons.open_in_new, onPressed: onOpen),
          ],
        ),
      ),
    );
  }
}

class _ConversionTimeoutView extends StatelessWidget {
  final VoidCallback onRetry;
  const _ConversionTimeoutView({required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppColors.textMuted),
            const SizedBox(height: 16),
            const Text(
              'تعذّر تجهيز ملف PDF لهذا التقرير',
              style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),
            const Text(
              'هذه الشاشة تعتمد على مكوّن "Android System WebView" في هاتفك لتحويل التقرير إلى PDF. '
              'إن استمرت المشكلة، جرّب تحديث هذا المكوّن من متجر Google Play ثم أعد المحاولة.',
              style: TextStyle(fontSize: 13, color: AppColors.textMuted, height: 1.6),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            PrimaryButton(label: 'إعادة المحاولة', color: kOvertimeColor, icon: Icons.refresh, onPressed: onRetry),
          ],
        ),
      ),
    );
  }
}
