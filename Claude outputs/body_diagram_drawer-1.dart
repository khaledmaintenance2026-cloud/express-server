import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:vector_math/vector_math_64.dart' show Matrix4;

/// أداة رسم تفاعلية لتحديد مكان الإصابة على مخطط الجسم.
///
/// بديل عن محاولة تخمين مكان الإصابة آليًا (سواء بوضع دائرة فوق إحداثيات
/// مقاسة يدويًا، أو بتلوين شكل مرسوم برمجيًا) — بناءً على طلب صريح: "قوم
/// بإنشاء مجسم تستطيع التلوين فيه على الإصابة" ثم التأكيد على أن يكون
/// "رسم تفاعلي داخل التطبيق". هنا تُعرض صورة جسم واقعية (نفس رسم الاستمارة
/// الرسمية، أمامي/خلفي)، ويرسم المستخدم بإصبعه مباشرة فوق مكان الإصابة
/// الحقيقي بدقة كاملة، ثم تُلتقط الصورة النهائية (المخطط + خط الرسم) كصورة
/// PNG واحدة تُرفَق بالتقرير — لا حسابات إحداثيات ولا تخمين مواقع بعد الآن؛
/// الدقة تعتمد على المستخدم نفسه الذي يرى الصورة ويرسم عليها مباشرة.
///
/// bodyInjurySide يحدد أي صورة تُعرض: 'front' فقط الأمامية، 'back' فقط
/// الخلفية، أو كلتاهما جنبًا إلى جنب لو لم تُحدَّد الجهة (null) — يمكن الرسم
/// على أي منهما ضمن نفس اللوحة (لوحة رسم واحدة تُلتقط كصورة واحدة).
class BodyDiagramDrawer extends StatefulWidget {
  final String? bodyInjurySide; // 'front' | 'back' | null (كلاهما)
  final String? initialImageUrl; // رابط صورة محفوظة مسبقًا (رابط كامل جاهز للعرض) — null لو لا توجد رسمة محفوظة
  final ValueChanged<String?> onChanged; // يُستدعى بصيغة data:image/png;base64,... عند كل تعديل، أو null عند المسح الكامل

  const BodyDiagramDrawer({
    super.key,
    required this.bodyInjurySide,
    required this.initialImageUrl,
    required this.onChanged,
  });

  @override
  State<BodyDiagramDrawer> createState() => _BodyDiagramDrawerState();
}

// خط واحد مرسوم (من ضغطة الإصبع وحتى رفعه) — يحمل سُمكه الخاص حتى تحتفظ كل
// علامة سابقة بسُمكها الأصلي حتى لو غيّر المستخدم اختيار سُمك القلم لاحقًا.
class _Stroke {
  final List<Offset> points = [];
  final double width;
  _Stroke(this.width);
}

class _BodyDiagramDrawerState extends State<BodyDiagramDrawer> {
  // أسماك القلم المتاحة — بطلب المستخدم صراحة: رفيع/سميك (مع خيار متوسط
  // إضافي بينهما كقيمة افتراضية معقولة).
  static const double _penThin = 4;
  static const double _penMedium = 9;
  static const double _penThick = 16;

  final GlobalKey _repaintKey = GlobalKey();
  final TransformationController _zoomController = TransformationController();
  final List<_Stroke> _strokes = [];
  _Stroke? _current;
  late bool _redrawMode;
  double _penWidth = _penMedium;
  double _zoom = 1.0;
  // false = وضع الرسم (الافتراضي): إصبع واحد يرسم، وأزرار التكبير تعمل.
  // true = وضع التكبير/التحريك: إصبعان (Pinch/Pan) يتحكمان بالعرض، والرسم
  // مُعطَّل مؤقتًا — فصل صريح بين الوضعين بدل الاعتماد على تمييز آلي لعدد
  // الأصابع (أكثر ثباتًا، لا يوجد تنافس بين أدوات التعرف على اللمس).
  bool _zoomMode = false;

  @override
  void initState() {
    super.initState();
    // لو توجد رسمة محفوظة مسبقًا (تعديل تقرير سابق) نعرضها كمعاينة أولًا
    // بدل فتح لوحة رسم فارغة مباشرة، مع زر لإعادة الرسم من جديد عند الحاجة.
    _redrawMode = widget.initialImageUrl == null;
  }

  @override
  void dispose() {
    _zoomController.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant BodyDiagramDrawer old) {
    super.didUpdateWidget(old);
    if (old.bodyInjurySide != widget.bodyInjurySide) {
      // تغيّرت جهة الإصابة (أمامي/خلفي) بعد رسم سابق — الصورة المعروضة لم
      // تعد مطابقة لاختيار الجهة الجديد، فتُمسَح العلامات وتبدأ لوحة جديدة.
      setState(() {
        _strokes.clear();
        _current = null;
        _resetZoom();
      });
      widget.onChanged(null);
    }
  }

  void _onPanStart(DragStartDetails d) {
    setState(() {
      _current = _Stroke(_penWidth)..points.add(d.localPosition);
      _strokes.add(_current!);
    });
  }

  void _onPanUpdate(DragUpdateDetails d) {
    setState(() => _current?.points.add(d.localPosition));
  }

  Future<void> _onPanEnd(DragEndDetails d) async {
    _current = null;
    await _capture();
  }

  Future<void> _undo() async {
    if (_strokes.isEmpty) return;
    setState(() => _strokes.removeLast());
    await _capture();
  }

  void _clear() {
    setState(() {
      _strokes.clear();
      _current = null;
    });
    widget.onChanged(null);
  }

  void _resetZoom() {
    _zoom = 1.0;
    _zoomController.value = Matrix4.identity();
  }

  void _zoomBy(double delta) {
    setState(() {
      _zoom = (_zoom + delta).clamp(1.0, 4.0);
      // تكبير/تصغير بسيط من الزاوية العلوية — يمكن للمستخدم بعدها تحريك
      // العرض بإصبعين (Pinch/Pan) للوصول للمكان الدقيق المطلوب الرسم فيه.
      _zoomController.value = Matrix4.identity()..scale(_zoom);
    });
  }

  Future<void> _capture() async {
    if (_strokes.isEmpty) {
      widget.onChanged(null);
      return;
    }
    // ننتظر انتهاء الإطار الحالي حتى تنعكس آخر التعديلات فعليًا داخل
    // RepaintBoundary قبل التقاطها كصورة.
    await WidgetsBinding.instance.endOfFrame;
    final boundary = _repaintKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null) return;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    if (byteData == null) return;
    final bytes = byteData.buffer.asUint8List();
    widget.onChanged('data:image/png;base64,${base64Encode(bytes)}');
  }

  @override
  Widget build(BuildContext context) {
    if (!_redrawMode && widget.initialImageUrl != null) {
      return _previewCard();
    }
    return _drawingCard();
  }

  Widget _previewCard() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: const Color(0xFFDDDDDD)),
        borderRadius: BorderRadius.circular(10),
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: Image.network(
              widget.initialImageUrl!,
              height: 230,
              fit: BoxFit.contain,
              errorBuilder: (_, __, ___) => const SizedBox(
                height: 230,
                child: Center(child: Text('تعذّر تحميل الرسمة المحفوظة', style: TextStyle(fontSize: 12, color: Colors.grey))),
              ),
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => setState(() => _redrawMode = true),
            icon: const Icon(Icons.edit_outlined, size: 17),
            label: const Text('تعديل / رسم من جديد', style: TextStyle(fontSize: 12.5)),
          ),
        ],
      ),
    );
  }

  Widget _drawingCard() {
    final showFront = widget.bodyInjurySide == null || widget.bodyInjurySide == 'front';
    final showBack = widget.bodyInjurySide == null || widget.bodyInjurySide == 'back';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: 300,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: Colors.white,
            border: Border.all(color: const Color(0xFFDDDDDD)),
            borderRadius: BorderRadius.circular(10),
          ),
          // InteractiveViewer (للتكبير/التموضع) وGestureDetector (للرسم)
          // يتنافسان لو فُعِّلا معًا في آنٍ واحد (كلاهما يتعامل مع سحب
          // الإصبع)، فالفصل بينهما هنا بوضعين صريحين (_zoomMode) بدل تفعيل
          // الاثنين معًا: في وضع الرسم تُعطَّل بادرات InteractiveViewer
          // تمامًا (panEnabled/scaleEnabled = false) فيستقبل GestureDetector
          // كل السحب، وفي وضع التكبير يُعطَّل GestureDetector (ردود أفعال
          // فارغة null) فتستقبل InteractiveViewer القرص/التحريك بلا منازع.
          // زرّا +/- يضبطان transformationController مباشرة، ويعملان في كلا
          // الوضعين لأنهما لا يمرّان عبر نظام البادرات أصلًا. RepaintBoundary
          // تبقى ثابتة الحجم الطبيعي دومًا بصرف النظر عن التكبير الحالي،
          // فتُلتقط الصورة النهائية كاملة دائمًا مهما كان مستوى التكبير وقت اللمس.
          child: InteractiveViewer(
            transformationController: _zoomController,
            panEnabled: _zoomMode,
            scaleEnabled: _zoomMode,
            minScale: 1.0,
            maxScale: 4.0,
            boundaryMargin: const EdgeInsets.all(80),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
              child: RepaintBoundary(
                key: _repaintKey,
                child: Container(
                  color: Colors.white,
                  child: GestureDetector(
                    onPanStart: _zoomMode ? null : _onPanStart,
                    onPanUpdate: _zoomMode ? null : _onPanUpdate,
                    onPanEnd: _zoomMode ? null : _onPanEnd,
                    child: Stack(
                      alignment: Alignment.topCenter,
                      children: [
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (showFront) _bodyPanel(_frontBodyImageBytes, 'أمامي'),
                            if (showFront && showBack) const SizedBox(width: 18),
                            if (showBack) _bodyPanel(_backBodyImageBytes, 'خلفي'),
                          ],
                        ),
                        Positioned.fill(child: CustomPaint(painter: _StrokesPainter(_strokes))),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        // Row قابلة للتمرير أفقيًا احتياطًا من تجاوز عرض الشاشة على الهواتف
        // الصغيرة (عدة أزرار ورقائق اختيار معًا في صف واحد).
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              const Text('الوضع:', style: TextStyle(fontSize: 12, color: Color(0xFF6B7280))),
              const SizedBox(width: 6),
              ChoiceChip(
                label: const Text('✏️ رسم', style: TextStyle(fontSize: 11.5)),
                selected: !_zoomMode,
                onSelected: (_) => setState(() => _zoomMode = false),
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              const SizedBox(width: 4),
              ChoiceChip(
                label: const Text('🔍 تكبير/تحريك', style: TextStyle(fontSize: 11.5)),
                selected: _zoomMode,
                onSelected: (_) => setState(() => _zoomMode = true),
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              const SizedBox(width: 14),
              IconButton(
                onPressed: _zoom <= 1.0 ? null : () => _zoomBy(-0.5),
                icon: const Icon(Icons.zoom_out, size: 20),
                tooltip: 'تصغير',
                visualDensity: VisualDensity.compact,
              ),
              Text('${(_zoom * 100).round()}%', style: const TextStyle(fontSize: 11.5, color: Color(0xFF6B7280))),
              IconButton(
                onPressed: _zoom >= 4.0 ? null : () => _zoomBy(0.5),
                icon: const Icon(Icons.zoom_in, size: 20),
                tooltip: 'تكبير للرسم بدقة أعلى',
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              const Text('سُمك القلم:', style: TextStyle(fontSize: 12, color: Color(0xFF6B7280))),
              const SizedBox(width: 6),
              _penSizeChip('رفيع', _penThin),
              const SizedBox(width: 4),
              _penSizeChip('متوسط', _penMedium),
              const SizedBox(width: 4),
              _penSizeChip('سميك', _penThick),
            ],
          ),
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            const Expanded(
              child: Text(
                'اختر "تكبير/تحريك" لتقريب المكان بدقة، ثم ارجع لوضع "رسم" وحدِّد مكان الإصابة',
                style: TextStyle(fontSize: 11.5, color: Color(0xFF6B7280)),
              ),
            ),
            TextButton.icon(
              onPressed: _strokes.isEmpty ? null : _undo,
              icon: const Icon(Icons.undo, size: 18),
              label: const Text('تراجع', style: TextStyle(fontSize: 12.5)),
            ),
            TextButton.icon(
              onPressed: _strokes.isEmpty ? null : _clear,
              icon: const Icon(Icons.delete_outline, size: 18),
              label: const Text('مسح', style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
      ],
    );
  }

  Widget _penSizeChip(String label, double width) {
    final selected = _penWidth == width;
    return ChoiceChip(
      label: Text(label, style: const TextStyle(fontSize: 11.5)),
      selected: selected,
      onSelected: (_) => setState(() => _penWidth = width),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      padding: const EdgeInsets.symmetric(horizontal: 4),
    );
  }

  Widget _bodyPanel(Uint8List bytes, String label) {
    return Column(
      children: [
        Text(label, style: const TextStyle(fontSize: 10, color: Color(0xFF8A8F98))),
        const SizedBox(height: 3),
        Image.memory(bytes, height: 230, fit: BoxFit.contain),
      ],
    );
  }
}

/// يرسم خطوط المستخدم (كل خط = مسار نقاط بين ضغطة وحتى رفع الإصبع) بلون
/// أسود مصمت فوق صورة الجسم — نفس لون العلامة النهائي المعتمد في التقرير.
class _StrokesPainter extends CustomPainter {
  final List<_Stroke> strokes;
  _StrokesPainter(this.strokes);

  @override
  void paint(Canvas canvas, Size size) {
    const color = Color(0xFF111111);
    final dotPaint = Paint()..color = color;
    for (final stroke in strokes) {
      if (stroke.points.isEmpty) continue;
      if (stroke.points.length == 1) {
        // نقرة واحدة بلا سحب (لم تتحرك الإصبع) — نقطة صغيرة بدل خط بلا طول.
        canvas.drawCircle(stroke.points.first, stroke.width / 2, dotPaint);
        continue;
      }
      final linePaint = Paint()
        ..color = color
        ..strokeWidth = stroke.width
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke;
      final path = Path()..moveTo(stroke.points.first.dx, stroke.points.first.dy);
      for (final p in stroke.points.skip(1)) {
        path.lineTo(p.dx, p.dy);
      }
      canvas.drawPath(path, linePaint);
    }
  }

  @override
  bool shouldRepaint(covariant _StrokesPainter oldDelegate) => true;
}

// تُفَك تشفيرها مرة واحدة فقط عند تحميل الملف (لا getter يُعاد حسابه في كل
// إعادة رسم) — قيمة Uint8List الثابتة نفسها تُمرَّر لكل Image.memory، فيتعرف
// عليها Flutter كصورة واحدة مخبَّأة (نفس المرجع) بدل إعادة فك تشفير JPEG في
// كل مرة يتحرك فيها الإصبع؛ كان هذا سبب اختفاء/وميض مخطط الجسم أثناء الرسم
// (كل onPanUpdate كان يعيد بناء صورة جديدة بالكامل عبر getter قديم).
final Uint8List _frontBodyImageBytes = base64Decode(_frontBodyImageB64);
final Uint8List _backBodyImageBytes = base64Decode(_backBodyImageB64);

// نفس صورتَي مخطط الجسم (أمامي/خلفي) المعتمدتين أصلًا في استمارة QMS-SAF-007
// الرسمية — نفس الصورة المقصوصة المستخدمة سابقًا في التقرير، مُعاد استخدامها
// هنا كخلفية للرسم التفاعلي بدل توليد أي شكل برمجي.
const _frontBodyImageB64 =
    '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';
const _backBodyImageB64 =
    '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';
