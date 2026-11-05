import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../../models/safety_permit.dart';
import '../../services/html_report_opener.dart';
import '../../services/safety_permit_html.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// تقرير PDF قابل للطباعة/المشاركة لطلب تصريح عمل واحد — من بداية الطلب
/// وحتى قرار قسم السلامة النهائي (قبول أو رفض)، يُبنى كـHTML محليًا بالكامل
/// (كل البيانات متوفرة أصلًا ضمن كائن SafetyPermit المُمرَّر — لا حاجة لأي
/// طلب إضافي من السيرفر، خلافًا لتقرير الصيانة). بنفس أسلوب
/// injury_report_print_screen.dart تمامًا: على أندرويد يُحوَّل مباشرة لملف
/// PDF عبر محرك عرض النظام (Printing.convertHtml)، وعلى الويب (غير مدعوم
/// هناك إطلاقًا) يُفتح نفس تقرير الـHTML في تبويب متصفح جديد بدلًا من ذلك.
class SafetyPermitPrintScreen extends StatefulWidget {
  final SafetyPermit permit;
  const SafetyPermitPrintScreen({super.key, required this.permit});

  @override
  State<SafetyPermitPrintScreen> createState() => _SafetyPermitPrintScreenState();
}

class _SafetyPermitPrintScreenState extends State<SafetyPermitPrintScreen> {
  bool _timedOut = false;
  int _attempt = 0;

  Future<Uint8List> _build(dynamic format) async {
    final html = buildSafetyPermitHtml(widget.permit);
    try {
      final bytes = await Printing.convertHtml(format: format, html: html).timeout(const Duration(seconds: 20));
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const ScreenTopBar(title: 'تقرير تصريح العمل'),
      body: kIsWeb
          ? _WebPrintView(
              color: AppColors.safety,
              onOpen: () => openHtmlReportInNewTab(buildSafetyPermitHtml(widget.permit)),
            )
          : (_timedOut
              ? _ConversionTimeoutView(onRetry: _retry)
              : PdfPreview(
                  key: ValueKey(_attempt),
                  build: _build,
                  allowSharing: true,
                  allowPrinting: true,
                  canChangeOrientation: false,
                  canChangePageFormat: false,
                  pdfFileName: 'تصريح_عمل_${widget.permit.id}.pdf',
                  loadingWidget: const Center(child: CircularProgressIndicator(color: AppColors.safety)),
                )),
    );
  }
}

/// شاشة فتح التقرير على الويب — بدل معاينة PDF داخل التطبيق (غير مدعومة على
/// الويب)، نعرض زرًا يفتح التقرير في تبويب جديد ليطبعه المستخدم أو يحفظه
/// كـPDF من نافذة الطباعة الخاصة بالمتصفح نفسه.
class _WebPrintView extends StatelessWidget {
  final Color color;
  final VoidCallback onOpen;
  const _WebPrintView({required this.color, required this.onOpen});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.picture_as_pdf_outlined, size: 48, color: color),
            const SizedBox(height: 16),
            const Text(
              'التقرير جاهز للفتح',
              style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),
            const Text(
              'اضغط الزر بالأسفل لفتح التقرير في تبويب جديد، ثم استخدم خاصية '
              'الطباعة في المتصفح (Ctrl+P أو ⌘+P) واختر "حفظ كـ PDF" لحفظه، '
              'أو اختر طابعتك للطباعة مباشرة.',
              style: TextStyle(fontSize: 13, color: AppColors.textMuted, height: 1.6),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            PrimaryButton(label: 'فتح التقرير', color: color, icon: Icons.open_in_new, onPressed: onOpen),
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
              'إن استمرت المشكلة، جرّب تحديث هذا التطبيق من متجر Google Play (ابحث عن "Android System WebView") ثم أعد المحاولة.',
              style: TextStyle(fontSize: 13, color: AppColors.textMuted, height: 1.6),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            PrimaryButton(label: 'إعادة المحاولة', color: AppColors.safety, icon: Icons.refresh, onPressed: onRetry),
          ],
        ),
      ),
    );
  }
}
