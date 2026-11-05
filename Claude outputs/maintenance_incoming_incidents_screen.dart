import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// بلاغات أعطال الإنتاج المفتوحة التي لم تتحوّل بعد إلى أمر عمل صيانة —
/// إنشاء بلاغ في الإنتاج (POST /production/incidents) يرسل إشعارًا فوريًا
/// (تطبيق + واتساب) لفريق الصيانة فقط، ولا ينشئ أمر عمل تلقائيًا؛ هذه
/// الشاشة هي الجسر: تعرض كل بلاغ لم يُحوَّل بعد، وبضغطة واحدة تُنشئ أمر
/// عمل طارئ حقيقي مرتبط به (راجع AppState.convertIncidentToWorkOrder)،
/// فيختفي البلاغ من هنا ويظهر أمر العمل في لوحة الصيانة بانتظار تعيين فني.
class MaintenanceIncomingIncidentsScreen extends StatefulWidget {
  const MaintenanceIncomingIncidentsScreen({super.key});

  @override
  State<MaintenanceIncomingIncidentsScreen> createState() => _MaintenanceIncomingIncidentsScreenState();
}

class _MaintenanceIncomingIncidentsScreenState extends State<MaintenanceIncomingIncidentsScreen> {
  final Set<String> _converting = {};

  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadIncidents());
  }

  Future<void> _convert(Incident incident) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تحويل إلى أمر عمل؟'),
        content: const Text('سيُنشأ أمر عمل صيانة طارئ من هذا البلاغ، ويصبح بانتظار تعيين فني له من لوحة الصيانة.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('تحويل')),
        ],
      ),
    );
    if (ok != true) return;

    setState(() => _converting.add(incident.id));
    try {
      await appState.convertIncidentToWorkOrder(incident);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم التحويل — عيّن فنيًا له من لوحة الصيانة')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر التحويل: $e')),
      );
    } finally {
      if (mounted) setState(() => _converting.remove(incident.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final incidents = state.incidents.where((i) => i.isOpen).toList();

    return Scaffold(
      appBar: const ScreenTopBar(title: 'بلاغات إنتاج بانتظار التحويل'),
      body: RefreshIndicator(
        onRefresh: () => state.reloadIncidents(),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 14),
              const InfoNote(
                text: 'كل بلاغ هنا وصل تنبيهه لجروب الصيانة عبر واتساب، لكنه لن يظهر كأمر عمل حتى تحوّله من هنا.',
                color: AppColors.maintenance,
                icon: Icons.sync_alt,
              ),
              const SizedBox(height: 12),
              if (state.incidentsError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: InfoNote(text: state.incidentsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                ),
              Expanded(
                child: !state.incidentsLoaded && state.incidentsError == null
                    ? const Center(child: CircularProgressIndicator())
                    : incidents.isEmpty
                        ? const Center(child: Text('لا توجد بلاغات إنتاج بانتظار التحويل حاليًا', style: TextStyle(color: AppColors.textMuted)))
                        : ListView.separated(
                            itemCount: incidents.length,
                            separatorBuilder: (_, __) => const SizedBox(height: 10),
                            itemBuilder: (context, i) {
                              final incident = incidents[i];
                              final converting = _converting.contains(incident.id);
                              final locationLabel = [
                                if (incident.lineName != null) incident.lineName!,
                                if (incident.facility != null) incident.facility!,
                              ].join(' — ');
                              return Container(
                                padding: const EdgeInsets.all(14),
                                decoration: BoxDecoration(
                                  color: AppColors.surface,
                                  border: Border.all(color: AppColors.border),
                                  borderRadius: BorderRadius.circular(16),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Expanded(
                                          child: Text(
                                            locationLabel.isEmpty ? 'بدون خط محدد' : locationLabel,
                                            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold),
                                          ),
                                        ),
                                        if (incident.severityLabel != null) ...[
                                          StatusPill(label: incident.severityLabel!, color: AppColors.textSecondary, background: AppColors.divider),
                                          const SizedBox(width: 6),
                                        ],
                                        const StatusPill(label: 'مفتوح', color: Color(0xFFB3261E), background: Color(0x1AB3261E)),
                                      ],
                                    ),
                                    const SizedBox(height: 6),
                                    if (incident.equipmentName != null) ...[
                                      Text(incident.equipmentName!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
                                      const SizedBox(height: 4),
                                    ],
                                    Text(incident.description, style: const TextStyle(fontSize: 13.5)),
                                    if (incident.expectedBatchNumber != null && incident.expectedBatchNumber!.isNotEmpty) ...[
                                      const SizedBox(height: 6),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                        decoration: BoxDecoration(
                                          color: AppColors.maintenance.withOpacity(0.1),
                                          borderRadius: BorderRadius.circular(8),
                                        ),
                                        child: Text(
                                          'الباتش المتوقع: ${incident.expectedBatchNumber} — سيُربط تلقائيًا عند تسجيله',
                                          style: const TextStyle(fontSize: 11, color: AppColors.maintenance, fontWeight: FontWeight.w600),
                                        ),
                                      ),
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
                                    const SizedBox(height: 10),
                                    Align(
                                      alignment: Alignment.centerLeft,
                                      child: converting
                                          ? const Padding(
                                              padding: EdgeInsets.all(6),
                                              child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.4)),
                                            )
                                          : ElevatedButton.icon(
                                              onPressed: () => _convert(incident),
                                              style: ElevatedButton.styleFrom(
                                                backgroundColor: AppColors.maintenance,
                                                foregroundColor: Colors.white,
                                                elevation: 0,
                                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                              ),
                                              icon: const Icon(Icons.build_circle_outlined, size: 17),
                                              label: const Text('تحويل إلى أمر عمل'),
                                            ),
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
    );
  }
}
