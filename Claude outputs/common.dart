import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';

/// تنسيق موحّد لحقول النماذج (TextField/DropdownButtonFormField) في كل شاشات
/// التطبيق تقريبًا — إطار خفيف بلون AppColors.border وحواف دائرية. مُستخرَج
/// هنا كي تستخدمه شاشات الموردين ومواقع العمل (inventory_suppliers_screen.dart
/// وinventory_work_sites_screen.dart) بلا تكرار محلي في كل ملف.
InputDecoration fieldDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}

/// شريط علوي موحّد بزر رجوع وعنوان، مطابق لتصميم الشاشات المعتمد.
class ScreenTopBar extends StatelessWidget implements PreferredSizeWidget {
  final String title;
  final List<Widget>? actions;

  const ScreenTopBar({super.key, required this.title, this.actions});

  @override
  Size get preferredSize => const Size.fromHeight(64);

  @override
  Widget build(BuildContext context) {
    return AppBar(
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
      leading: Padding(
        padding: const EdgeInsets.all(12),
        child: Container(
          decoration: BoxDecoration(
            color: AppColors.surface,
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(12),
          ),
          child: IconButton(
            icon: const Icon(Icons.arrow_forward, size: 20),
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        ),
      ),
      actions: actions,
    );
  }
}

/// شارة صغيرة ملوّنة لعرض الحالة (بانتظار التعيين، قيد التنفيذ، مكتمل...).
class StatusPill extends StatelessWidget {
  final String label;
  final Color color;
  final Color background;

  const StatusPill({super.key, required this.label, required this.color, required this.background});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(999)),
      child: Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: color)),
    );
  }
}

/// زر رئيسي بعرض كامل بلون القسم.
class PrimaryButton extends StatelessWidget {
  final String label;
  final Color color;
  final VoidCallback? onPressed;
  final IconData? icon;

  const PrimaryButton({super.key, required this.label, required this.color, this.onPressed, this.icon});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: ElevatedButton(
        style: ElevatedButton.styleFrom(
          backgroundColor: color,
          foregroundColor: Colors.white,
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
        onPressed: onPressed,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 18),
              const SizedBox(width: 8),
            ],
            Text(label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }
}

/// بطاقة مؤشر رقمي (KPI) صغيرة تُستخدم في أعلى شاشات اللوحات والتقارير.
class KpiCard extends StatelessWidget {
  final String value;
  final String label;
  final Color valueColor;

  const KpiCard({super.key, required this.value, required this.label, required this.valueColor});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: valueColor)),
            const SizedBox(height: 3),
            Text(label, style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
          ],
        ),
      ),
    );
  }
}

/// صندوق تنبيه معلوماتي بلون خفيف (يُستخدم لتوضيح مصير الإشعار مثلاً).
class InfoNote extends StatelessWidget {
  final String text;
  final Color color;
  final IconData icon;

  const InfoNote({super.key, required this.text, required this.color, this.icon = Icons.notifications_active_outlined});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: color.withOpacity(0.08), borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, color: color))),
        ],
      ),
    );
  }
}

/// عارض صورة بملء الشاشة (تكبير/تصغير باللمس عبر InteractiveViewer) مع زر
/// "تنزيل الصورة" — يفتحها في المتصفح/تطبيق خارجي (على أندرويد يقدر المستخدم
/// يضغط عليها مطوّلًا ليحفظها في معرض الصور، وعلى الويب تُفتح في تبويب جديد
/// فيقدر يحفظها بكليك يمين ← حفظ الصورة). يُستخدم لعرض صور بلاغات الأعطال
/// وأي صورة أخرى محفوظة كملف عادي على السيرفر.
class FullScreenPhotoViewer extends StatelessWidget {
  final String url;
  const FullScreenPhotoViewer({super.key, required this.url});

  Future<void> _download(BuildContext context) async {
    final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تعذّر فتح الصورة لتنزيلها')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(
            icon: const Icon(Icons.download_outlined),
            tooltip: 'تنزيل الصورة',
            onPressed: () => _download(context),
          ),
        ],
      ),
      body: Center(
        child: InteractiveViewer(
          minScale: 0.5,
          maxScale: 4,
          child: Image.network(
            url,
            fit: BoxFit.contain,
            errorBuilder: (_, __, ___) => const Text('تعذّر تحميل الصورة', style: TextStyle(color: Colors.white70)),
          ),
        ),
      ),
    );
  }
}

/// مصغّر صورة قابل للضغط — يفتح [FullScreenPhotoViewer] لعرض الصورة كاملة
/// وواضحة (بدون قصّ) مع خيار تنزيلها. استُخدم بدل Image.network مباشرة في أي
/// مكان تُعرَض فيه صورة بلاغ محفوظة على السيرفر.
class PhotoThumbnailButton extends StatelessWidget {
  final String url;
  final double height;
  const PhotoThumbnailButton({super.key, required this.url, this.height = 130});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(fullscreenDialog: true, builder: (_) => FullScreenPhotoViewer(url: url)),
      ),
      child: Stack(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.network(
              url,
              height: height,
              width: double.infinity,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
            ),
          ),
          Positioned(
            bottom: 6,
            left: 6,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(color: Colors.black.withOpacity(0.55), borderRadius: BorderRadius.circular(8)),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.zoom_in, size: 13, color: Colors.white),
                  SizedBox(width: 4),
                  Text('عرض كاملة وتنزيل', style: TextStyle(fontSize: 10.5, color: Colors.white)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
