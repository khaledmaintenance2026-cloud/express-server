/// نماذج بيانات صفحة "تحليل الصيانة" الجديدة (طلب 2026-10-03: "كـ إدارة
/// الصيانة أريد صفحة للتحليل — المهام وعمل الفنيين") — مصدرها GET
/// /api/maintenance-analysis على السيرفر (راجع routes/maintenanceAnalysis.js).
/// الصفحة مقصورة على مسؤول الصيانة (ومدير النظام تلقائيًا) فقط.

/// ملخص الفترة المحددة: إجمالي أوامر العمل، حالاتها، ومتوسط وقت الإصلاح،
/// بالإضافة لتوزيعها الثلاثي (أعطال طارئة / أعمال وقائية / مهام عامة).
class MaintenanceAnalysisSummary {
  final int total;
  final int completed;
  final int open;
  final int cancelled;
  final int? avgResolutionMinutes;
  final int taskCount;
  final int emergencyCount;
  final int preventiveCount;

  const MaintenanceAnalysisSummary({
    required this.total,
    required this.completed,
    required this.open,
    required this.cancelled,
    required this.avgResolutionMinutes,
    required this.taskCount,
    required this.emergencyCount,
    required this.preventiveCount,
  });

  factory MaintenanceAnalysisSummary.fromJson(Map<String, dynamic> json) {
    final byKind = (json['byKind'] as Map?)?.cast<String, dynamic>() ?? const {};
    return MaintenanceAnalysisSummary(
      total: (json['total'] as num?)?.toInt() ?? 0,
      completed: (json['completed'] as num?)?.toInt() ?? 0,
      open: (json['open'] as num?)?.toInt() ?? 0,
      cancelled: (json['cancelled'] as num?)?.toInt() ?? 0,
      avgResolutionMinutes: (json['avgResolutionMinutes'] as num?)?.toInt(),
      taskCount: (byKind['task'] as num?)?.toInt() ?? 0,
      emergencyCount: (byKind['emergency'] as num?)?.toInt() ?? 0,
      preventiveCount: (byKind['preventive'] as num?)?.toInt() ?? 0,
    );
  }
}

/// نقطة واحدة في الرسم البياني الزمني — يوم أو أسبوع (حسب [bucket] في
/// [MaintenanceAnalysis]) مع عدد الأوامر التي أُنشئت وعدد التي أُنجزت فيه.
class MaintenanceTrendPoint {
  final DateTime date;
  final int created;
  final int completed;

  const MaintenanceTrendPoint({required this.date, required this.created, required this.completed});

  factory MaintenanceTrendPoint.fromJson(Map<String, dynamic> json) => MaintenanceTrendPoint(
        date: DateTime.parse(json['date'] as String),
        created: (json['created'] as num?)?.toInt() ?? 0,
        completed: (json['completed'] as num?)?.toInt() ?? 0,
      );
}

/// أداء فني واحد خلال الفترة المحددة: عدد المهام المنجزة، المتوسط الزمني
/// لإنجازها، وعدد المهام المفتوحة (غير المنجزة بعد) التي أُسندت له.
class TechnicianPerformance {
  final String id;
  final String name;
  final int completedCount;
  final int openCount;
  final int? avgResolutionMinutes;

  const TechnicianPerformance({
    required this.id,
    required this.name,
    required this.completedCount,
    required this.openCount,
    required this.avgResolutionMinutes,
  });

  factory TechnicianPerformance.fromJson(Map<String, dynamic> json) => TechnicianPerformance(
        id: json['id'].toString(),
        name: json['name'] as String? ?? '',
        completedCount: (json['completedCount'] as num?)?.toInt() ?? 0,
        openCount: (json['openCount'] as num?)?.toInt() ?? 0,
        avgResolutionMinutes: (json['avgResolutionMinutes'] as num?)?.toInt(),
      );
}

class MaintenanceAnalysis {
  final DateTime from;
  final DateTime to;
  final String bucket; // 'day' أو 'week'
  final MaintenanceAnalysisSummary summary;
  final List<MaintenanceTrendPoint> trend;
  final List<TechnicianPerformance> technicians;

  const MaintenanceAnalysis({
    required this.from,
    required this.to,
    required this.bucket,
    required this.summary,
    required this.trend,
    required this.technicians,
  });

  factory MaintenanceAnalysis.fromJson(Map<String, dynamic> json) {
    final range = (json['range'] as Map).cast<String, dynamic>();
    return MaintenanceAnalysis(
      from: DateTime.parse(range['from'] as String),
      to: DateTime.parse(range['to'] as String),
      bucket: range['bucket'] as String? ?? 'day',
      summary: MaintenanceAnalysisSummary.fromJson((json['summary'] as Map).cast<String, dynamic>()),
      trend: ((json['trend'] as List?) ?? const [])
          .map((e) => MaintenanceTrendPoint.fromJson((e as Map).cast<String, dynamic>()))
          .toList(),
      technicians: ((json['technicians'] as List?) ?? const [])
          .map((e) => TechnicianPerformance.fromJson((e as Map).cast<String, dynamic>()))
          .toList(),
    );
  }
}
