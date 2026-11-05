import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'production_equipment_screen.dart';

/// بلاغات أعطال/توقف قسم الإنتاج — مربوطة بمسار /production/incidents
/// الموجود فعليًا على سيرفر صيانتي المحلي. كل قسم (مصنع رجال/نساء) يرى
/// فقط بلاغات خطوطه، فتبقى إدارة كل قسم مستقلة عن الآخر.
///
/// يدعم النموذج أيضًا اختيار معدة من قائمة معدات القسم (تُدار من شاشة
/// ProductionEquipmentScreen) وإرفاق صورة اختيارية للعطل — كلاهما يظهر
/// تلقائيًا في رسالة واتساب "بلاغ عطل مفاجئ" (راجع services/notifications.js
/// على السيرفر).
class ProductionIncidentsScreen extends StatefulWidget {
  final String facility;
  const ProductionIncidentsScreen({super.key, required this.facility});

  @override
  State<ProductionIncidentsScreen> createState() => _ProductionIncidentsScreenState();
}

class _ProductionIncidentsScreenState extends State<ProductionIncidentsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      context.read<AppState>().reloadIncidents();
      context.read<AppState>().reloadEquipment();
    });
  }

  Future<void> _openForm(BuildContext context) async {
    final appState = context.read<AppState>();
    final lines = appState.linesByFacility(widget.facility);
    final descCtrl = TextEditingController();
    String? selectedLineId = lines.isNotEmpty ? lines.first.id : null;
    // تصنيف حدة العطل — يظهر لاحقًا في رسالة واتساب "بلاغ عطل مفاجئ" (اختياري).
    String? selectedSeverity;
    String? selectedEquipmentId;
    Uint8List? photoBytes;
    String? photoDataUrl;
    bool submitting = false;
    String? error;

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          Future<void> pickPhoto(ImageSource source) async {
            try {
              final picked = await ImagePicker().pickImage(source: source, maxWidth: 2000, imageQuality: 90);
              if (picked == null) return;
              final bytes = await picked.readAsBytes();
              final name = picked.name.toLowerCase();
              final ext = name.endsWith('.png') ? 'png' : (name.endsWith('.webp') ? 'webp' : 'jpeg');
              setSheetState(() {
                photoBytes = bytes;
                photoDataUrl = 'data:image/$ext;base64,${base64Encode(bytes)}';
              });
            } catch (e) {
              setSheetState(() => error = 'تعذّر اختيار الصورة: $e');
            }
          }

          void showPhotoSourceSheet() {
            showModalBottomSheet(
              context: ctx,
              builder: (sheetCtx) => SafeArea(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ListTile(
                      leading: const Icon(Icons.photo_camera_outlined),
                      title: const Text('التقاط صورة بالكاميرا'),
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        pickPhoto(ImageSource.camera);
                      },
                    ),
                    ListTile(
                      leading: const Icon(Icons.photo_library_outlined),
                      title: const Text('اختيار من المعرض'),
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        pickPhoto(ImageSource.gallery);
                      },
                    ),
                  ],
                ),
              ),
            );
          }

          final facilityEquipment = appState.equipmentByFacility(widget.facility);
          // فلترة المعدات حسب الخط المُحدد: عند اختيار خط معيّن (مثلاً خط 7)
          // تظهر فقط معداته، وعند اختيار "بدون خط محدد" تظهر فقط المعدات
          // العامة غير المرتبطة بأي خط (lineId == null) — وليس كل معدات القسم.
          final filteredEquipment =
              facilityEquipment.where((e) => e.lineId == selectedLineId).toList();

          return Padding(
            padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
            child: Container(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
              decoration: const BoxDecoration(
                color: AppColors.background,
                borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('بلاغ عطل جديد — ${widget.facility}',
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 16),
                    if (lines.isNotEmpty) ...[
                      const Align(alignment: Alignment.centerRight, child: Text('الخط المتعلّق (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                      const SizedBox(height: 6),
                      DropdownButtonFormField<String?>(
                        value: selectedLineId,
                        decoration: _decoration(),
                        items: [
                          const DropdownMenuItem<String?>(value: null, child: Text('بدون خط محدد')),
                          ...lines.map((l) => DropdownMenuItem<String?>(value: l.id, child: Text(l.name))),
                        ],
                        onChanged: (v) => setSheetState(() {
                          selectedLineId = v;
                          // إعادة ضبط المعدة المختارة لأنها قد لا تكون ضمن
                          // قائمة معدات الخط الجديد بعد الفلترة.
                          selectedEquipmentId = null;
                        }),
                      ),
                      const SizedBox(height: 12),
                    ],
                    const Align(alignment: Alignment.centerRight, child: Text('المعدة (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String?>(
                      value: selectedEquipmentId,
                      decoration: _decoration(
                        hint: facilityEquipment.isEmpty
                            ? 'لا توجد معدات مسجّلة بعد'
                            : (filteredEquipment.isEmpty ? 'لا توجد معدات على هذا الخط' : null),
                      ),
                      items: [
                        const DropdownMenuItem<String?>(value: null, child: Text('بدون معدة محددة')),
                        ...filteredEquipment.map((e) => DropdownMenuItem<String?>(
                              value: e.id,
                              child: Text(
                                (e.code != null && e.code!.isNotEmpty) ? '${e.name} (${e.code})' : e.name,
                                overflow: TextOverflow.ellipsis,
                              ),
                            )),
                      ],
                      onChanged: (v) => setSheetState(() => selectedEquipmentId = v),
                    ),
                    const SizedBox(height: 4),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: () => Navigator.of(ctx).push(
                          MaterialPageRoute(builder: (_) => ProductionEquipmentScreen(facility: widget.facility)),
                        ),
                        icon: const Icon(Icons.settings_outlined, size: 16),
                        label: const Text('إدارة قائمة المعدات', style: TextStyle(fontSize: 12.5)),
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Align(alignment: Alignment.centerRight, child: Text('وصف العطل', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                    const SizedBox(height: 6),
                    TextField(
                      controller: descCtrl,
                      maxLines: 3,
                      decoration: _decoration(hint: 'مثال: توقف مفاجئ بسبب عطل ميكانيكي في السير'),
                      onChanged: (_) => setSheetState(() {}),
                    ),
                    const SizedBox(height: 12),
                    const Align(alignment: Alignment.centerRight, child: Text('نوع العطل (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: const [
                        MapEntry('simple', 'بسيط'),
                        MapEntry('medium', 'متوسط'),
                        MapEntry('critical', 'حرج'),
                      ].map((entry) {
                        final selected = selectedSeverity == entry.key;
                        return ChoiceChip(
                          label: Text(entry.value),
                          selected: selected,
                          selectedColor: AppColors.production.withOpacity(0.22),
                          onSelected: (_) => setSheetState(() => selectedSeverity = selected ? null : entry.key),
                        );
                      }).toList(),
                    ),
                    const SizedBox(height: 12),
                    const Align(alignment: Alignment.centerRight, child: Text('صورة العطل (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                    const SizedBox(height: 8),
                    _ReportPhotoPicker(bytes: photoBytes, onTap: showPhotoSourceSheet),
                    if (error != null) ...[
                      const SizedBox(height: 10),
                      InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                    ],
                    const SizedBox(height: 18),
                    PrimaryButton(
                      label: 'إرسال البلاغ',
                      color: AppColors.production,
                      onPressed: submitting || descCtrl.text.trim().isEmpty
                          ? null
                          : () async {
                              setSheetState(() {
                                submitting = true;
                                error = null;
                              });
                              try {
                                await appState.addIncidentCloud(
                                  lineId: selectedLineId,
                                  equipmentId: selectedEquipmentId,
                                  description: descCtrl.text.trim(),
                                  severity: selectedSeverity,
                                  photo: photoDataUrl,
                                );
                                if (ctx.mounted) Navigator.of(ctx).pop();
                              } catch (e) {
                                setSheetState(() {
                                  submitting = false;
                                  error = 'تعذّر إرسال البلاغ: $e';
                                });
                              }
                            },
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, Incident incident) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف البلاغ؟'),
        content: const Text('سيُحذف هذا البلاغ نهائيًا.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok == true) await appState.removeIncidentCloud(incident.id);
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final lineIds = state.linesByFacility(widget.facility).map((l) => l.id).toSet();
    final incidents = state.incidents.where((i) => i.lineId != null && lineIds.contains(i.lineId)).toList();

    return Scaffold(
      appBar: ScreenTopBar(title: 'بلاغات ${widget.facility}'),
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 90),
            child: RefreshIndicator(
              onRefresh: () => state.reloadIncidents(),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 14),
                  if (state.incidentsError != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: InfoNote(text: state.incidentsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                    ),
                  Expanded(
                    child: !state.incidentsLoaded && state.incidentsError == null
                        ? const Center(child: CircularProgressIndicator())
                        : incidents.isEmpty
                            ? const Center(child: Text('لا توجد بلاغات في هذا القسم — اضغط + للإضافة', style: TextStyle(color: AppColors.textMuted)))
                            : ListView.separated(
                                itemCount: incidents.length,
                                separatorBuilder: (_, __) => const SizedBox(height: 10),
                                itemBuilder: (context, i) {
                                  final incident = incidents[i];
                                  final lineName = incident.lineId != null
                                      ? (state.productionLines.where((l) => l.id == incident.lineId).isEmpty
                                          ? incident.lineName
                                          : state.lineById(incident.lineId!).name)
                                      : null;
                                  return Container(
                                    padding: const EdgeInsets.all(14),
                                    decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            Expanded(
                                              child: Text(lineName ?? 'بدون خط محدد', style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold)),
                                            ),
                                            if (incident.severityLabel != null) ...[
                                              StatusPill(
                                                label: incident.severityLabel!,
                                                color: AppColors.textSecondary,
                                                background: AppColors.divider,
                                              ),
                                              const SizedBox(width: 6),
                                            ],
                                            StatusPill(
                                              label: incident.isOpen ? 'مفتوح' : 'مغلق',
                                              color: incident.isOpen ? const Color(0xFFB3261E) : const Color(0xFF2E7D32),
                                              background: (incident.isOpen ? const Color(0xFFB3261E) : const Color(0xFF2E7D32)).withOpacity(0.1),
                                            ),
                                          ],
                                        ),
                                        const SizedBox(height: 6),
                                        Text(incident.description, style: const TextStyle(fontSize: 13.5)),
                                        if (incident.equipmentName != null && incident.equipmentName!.isNotEmpty) ...[
                                          const SizedBox(height: 4),
                                          Text('المعدة: ${incident.equipmentName}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                                        ],
                                        const SizedBox(height: 8),
                                        Text(
                                          'بلّغ: ${incident.reportedBy} — ${ArabicFormat.dateTime(incident.reportedAt)} — توقف: ${ArabicFormat.duration(Duration(minutes: incident.downtimeMinutes))}',
                                          style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
                                        ),
                                        if (incident.photoPath != null) ...[
                                          const SizedBox(height: 8),
                                          PhotoThumbnailButton(url: '$kApiOrigin${incident.photoPath}'),
                                        ],
                                        const SizedBox(height: 8),
                                        Row(
                                          children: [
                                            if (incident.isOpen)
                                              TextButton.icon(
                                                onPressed: () => state.endIncidentDowntimeCloud(incident.id),
                                                icon: const Icon(Icons.check_circle_outline, size: 17),
                                                label: const Text('إنهاء التوقف'),
                                              ),
                                            const Spacer(),
                                            IconButton(
                                              icon: const Icon(Icons.delete_outline, size: 19, color: Color(0xFFB3261E)),
                                              onPressed: () => _confirmDelete(context, incident),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
                                  );
                                },
                              ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            bottom: 20,
            left: 20,
            child: FloatingActionButton(
              backgroundColor: AppColors.production,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
              onPressed: () => _openForm(context),
              child: const Icon(Icons.add, color: Colors.white),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReportPhotoPicker extends StatelessWidget {
  final Uint8List? bytes;
  final VoidCallback onTap;

  const _ReportPhotoPicker({required this.bytes, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Container(
        height: 140,
        width: double.infinity,
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: bytes != null ? AppColors.production : AppColors.border, width: bytes != null ? 1.6 : 1),
          borderRadius: BorderRadius.circular(14),
        ),
        clipBehavior: Clip.antiAlias,
        child: bytes != null
            ? Stack(
                fit: StackFit.expand,
                children: [
                  Image.memory(bytes!, fit: BoxFit.cover),
                  Positioned(
                    bottom: 8,
                    left: 8,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(color: Colors.black.withOpacity(0.55), borderRadius: BorderRadius.circular(10)),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.refresh, size: 14, color: Colors.white),
                          SizedBox(width: 6),
                          Text('تغيير الصورة', style: TextStyle(fontSize: 11.5, color: Colors.white)),
                        ],
                      ),
                    ),
                  ),
                ],
              )
            : const Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.add_a_photo_outlined, size: 26, color: AppColors.textMuted),
                    SizedBox(height: 8),
                    Text('التقاط أو اختيار صورة', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
                  ],
                ),
              ),
      ),
    );
  }
}

InputDecoration _decoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.background,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}
