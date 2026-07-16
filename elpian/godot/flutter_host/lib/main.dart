// =============================================================================
// main.dart — the Elpian Flutter host: a declarative widget-tree interpreter.
// =============================================================================
//
// This is the FIXED Flutter app the GDExtension embeds (see ../FLUTTER.md and
// ../extension/src/flutter_view.cpp). It contains NO application logic. Its only
// job is to be a faithful renderer of the widget trees the Elpian VM sends, and
// to route every widget event back:
//
//   Elpian VM guest (dynamic, no JIT)                 this app (static, AOT)
//   ─────────────────────────────────                ──────────────────────
//   FL.el('AnyWidget', props, children) ─render op─▶  _buildNode -> real widget
//   a handler fires (any event type) ───events chan─▶  {cb, args} -> __godotDispatch
//                                                       -> the owning VM's closure
//
// Coverage strategy (see FLUTTER.md, "Why a registry and not reflection"):
// Flutter's widget framework is AOT Dart with no runtime reflection, so there is
// no ClassDB-style "reach every widget by name" seam. Coverage is therefore a
// property of THIS file: a large hand-written registry below, plus a build-time
// generator (tool/gen_registry.dart) that closes it to the full public API and
// keeps it current with the SDK — the Flutter analogue of the Godot bridge's
// generated @GlobalScope table. The guest side is already complete by
// construction (any widget type + any handler is expressible), so this app is
// the single place coverage is defined.
//
// The EVENT surface here is exhaustive: every GestureDetector callback, every
// Listener pointer event, keyboard/focus, drag & drop, scroll notifications, and
// every widget-specific value callback, each serialized to a JSON details object
// the guest handler receives as its argument.

import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

// The generated registry (tool/gen_registry.dart): a `buildGenerated` fallback
// covering the full public widget/enum API. A committed stub returns null so
// this file compiles before the generator has run; running the generator
// overwrites it with the complete mapping — see ../FLUTTER.md.
part 'registry.g.dart';

const _widgetsChannel = BasicMessageChannel<String>('elpian/widgets', StringCodec());
const _eventsChannel = BasicMessageChannel<String>('elpian/events', StringCodec());

void main() => runApp(const _ElpianHostApp());

class _ElpianHostApp extends StatefulWidget {
  const _ElpianHostApp();
  @override
  State<_ElpianHostApp> createState() => _ElpianHostState();
}

class _ElpianHostState extends State<_ElpianHostApp> {
  Map<String, dynamic>? _root;
  late final _Interp _interp = _Interp(_fire);

  @override
  void initState() {
    super.initState();
    _widgetsChannel.setMessageHandler((String? message) async {
      if (message != null) {
        final decoded = json.decode(message);
        if (decoded is Map<String, dynamic>) {
          setState(() => _root = decoded);
        }
      }
      return null;
    });
  }

  void _fire(int cb, List<dynamic> args) => _eventsChannel.send(json.encode({'cb': cb, 'args': args}));

  @override
  Widget build(BuildContext context) {
    final root = _root;
    if (root == null) return const SizedBox.shrink();
    final built = _interp.build(root);
    // Ensure a Material/Directionality context if the guest did not root a
    // MaterialApp/CupertinoApp itself.
    if (root['t'] == 'MaterialApp' || root['t'] == 'CupertinoApp' || root['t'] == 'WidgetsApp') {
      return built;
    }
    return MaterialApp(debugShowCheckedModeBanner: false, home: built);
  }
}

// =============================================================================
// The interpreter.
// =============================================================================

typedef _Fire = void Function(int cb, List<dynamic> args);

class _Interp {
  _Interp(this.fire);
  final _Fire fire;

  // ---- node -> widget -------------------------------------------------------

  Widget build(dynamic node) {
    if (node == null) return const SizedBox.shrink();
    if (node is String) return Text(node);
    if (node is num || node is bool) return Text('$node');
    if (node is! Map) return const SizedBox.shrink();

    final String type = node['t'] as String? ?? '';
    final _P p = _P(node['p'] as Map? ?? const {}, this);
    final List raw = node['c'] as List? ?? const [];
    List<Widget> kids() => raw.map(build).toList();
    Widget kid() => raw.isEmpty ? const SizedBox.shrink() : build(raw.first);
    final Key? key = _key(node['k']);

    switch (type) {
      // ---- apps / structure -------------------------------------------------
      case 'MaterialApp':
        return MaterialApp(
          key: key,
          debugShowCheckedModeBanner: false,
          theme: p.has('dark') && p.b('dark') ? ThemeData.dark() : ThemeData.light(),
          home: p.w('home'),
        );
      case 'CupertinoApp':
        return CupertinoApp(key: key, debugShowCheckedModeBanner: false, home: p.w('home'));
      case 'Scaffold':
        return Scaffold(
          key: key,
          backgroundColor: p.color('backgroundColor'),
          appBar: p.pref('appBar'),
          body: p.w('body'),
          drawer: p.w('drawer'),
          endDrawer: p.w('endDrawer'),
          bottomNavigationBar: p.w('bottomNavigationBar'),
          bottomSheet: p.w('bottomSheet'),
          floatingActionButton: p.w('floatingActionButton') ?? p.w('fab'),
          floatingActionButtonLocation: _fabLoc(p.s('fabLocation')),
          resizeToAvoidBottomInset: p.hasB('resizeToAvoidBottomInset'),
        );
      case 'AppBar':
        return AppBar(
          key: key,
          title: p.w('title'),
          centerTitle: p.hasB('centerTitle'),
          backgroundColor: p.color('backgroundColor'),
          leading: p.w('leading'),
          actions: p.wl('actions'),
          elevation: p.d('elevation'),
          bottom: p.pref('bottom'),
        );
      case 'SliverAppBar':
        return SliverAppBar(
          key: key,
          title: p.w('title'),
          pinned: p.hasB('pinned'),
          floating: p.hasB('floating'),
          expandedHeight: p.d('expandedHeight'),
          backgroundColor: p.color('backgroundColor'),
          actions: p.wl('actions'),
        );

      // ---- layout -----------------------------------------------------------
      case 'Container':
        return Container(
          key: key,
          alignment: p.align('alignment'),
          padding: p.edge('padding') ?? p.edge('pad'),
          margin: p.edge('margin'),
          color: p.has('decoration') ? null : p.color('color'),
          width: p.d('width'),
          height: p.d('height'),
          constraints: p.constraints('constraints'),
          decoration: p.decoration('decoration'),
          transform: p.matrix('transform'),
          child: raw.isEmpty ? p.w('child') : kid(),
        );
      case 'Center':
        return Center(key: key, widthFactor: p.d('widthFactor'), heightFactor: p.d('heightFactor'), child: raw.isEmpty ? p.w('child') : kid());
      case 'Align':
        return Align(key: key, alignment: p.align('alignment') ?? Alignment.center, child: raw.isEmpty ? p.w('child') : kid());
      case 'Padding':
        return Padding(key: key, padding: p.edge('all') ?? p.edge('padding') ?? EdgeInsets.zero, child: raw.isEmpty ? p.w('child') : kid());
      case 'SizedBox':
        return SizedBox(key: key, width: p.d('width'), height: p.d('height'), child: raw.isEmpty ? p.w('child') : kid());
      case 'ConstrainedBox':
        return ConstrainedBox(key: key, constraints: p.constraints('constraints') ?? const BoxConstraints(), child: raw.isEmpty ? p.w('child') : kid());
      case 'FractionallySizedBox':
        return FractionallySizedBox(key: key, widthFactor: p.d('widthFactor'), heightFactor: p.d('heightFactor'), alignment: p.align('alignment') ?? Alignment.center, child: raw.isEmpty ? p.w('child') : kid());
      case 'AspectRatio':
        return AspectRatio(key: key, aspectRatio: p.d('aspectRatio') ?? 1.0, child: raw.isEmpty ? p.w('child') : kid());
      case 'FittedBox':
        return FittedBox(key: key, fit: _boxFit(p.s('fit')) ?? BoxFit.contain, alignment: p.align('alignment') ?? Alignment.center, child: raw.isEmpty ? p.w('child') : kid());
      case 'IntrinsicHeight':
        return IntrinsicHeight(key: key, child: kid());
      case 'IntrinsicWidth':
        return IntrinsicWidth(key: key, child: kid());
      case 'LimitedBox':
        return LimitedBox(key: key, maxWidth: p.d('maxWidth') ?? double.infinity, maxHeight: p.d('maxHeight') ?? double.infinity, child: kid());
      case 'Offstage':
        return Offstage(key: key, offstage: p.hasB('offstage'), child: kid());
      case 'Column':
        return Column(key: key, mainAxisAlignment: _mainAxis(p.s('main')), crossAxisAlignment: _crossAxis(p.s('cross')), mainAxisSize: _mainSize(p.s('size')), children: kids());
      case 'Row':
        return Row(key: key, mainAxisAlignment: _mainAxis(p.s('main')), crossAxisAlignment: _crossAxis(p.s('cross')), mainAxisSize: _mainSize(p.s('size')), children: kids());
      case 'Flex':
        return Flex(key: key, direction: _axis(p.s('direction')), mainAxisAlignment: _mainAxis(p.s('main')), crossAxisAlignment: _crossAxis(p.s('cross')), children: kids());
      case 'Wrap':
        return Wrap(key: key, spacing: p.d('spacing') ?? 0.0, runSpacing: p.d('runSpacing') ?? 0.0, alignment: _wrapAlign(p.s('alignment')), direction: _axis(p.s('direction')), children: kids());
      case 'Stack':
        return Stack(key: key, alignment: p.align('alignment') ?? AlignmentDirectional.topStart, fit: _stackFit(p.s('fit')), children: kids());
      case 'IndexedStack':
        return IndexedStack(key: key, index: p.i('index') ?? 0, alignment: p.align('alignment') ?? AlignmentDirectional.topStart, children: kids());
      case 'Positioned':
        return Positioned(key: key, left: p.d('left'), top: p.d('top'), right: p.d('right'), bottom: p.d('bottom'), width: p.d('width'), height: p.d('height'), child: raw.isEmpty ? (p.w('child') ?? const SizedBox()) : kid());
      case 'Expanded':
        return Expanded(key: key, flex: p.i('flex') ?? 1, child: raw.isEmpty ? (p.w('child') ?? const SizedBox()) : kid());
      case 'Flexible':
        return Flexible(key: key, flex: p.i('flex') ?? 1, fit: p.b('tight') ? FlexFit.tight : FlexFit.loose, child: raw.isEmpty ? (p.w('child') ?? const SizedBox()) : kid());
      case 'Spacer':
        return Spacer(key: key, flex: p.i('flex') ?? 1);
      case 'Transform':
        return Transform(key: key, transform: p.matrix('matrix') ?? Matrix4.identity(), alignment: p.align('alignment'), child: kid());
      case 'Opacity':
        return Opacity(key: key, opacity: p.d('opacity') ?? 1.0, child: kid());
      case 'ClipRRect':
        return ClipRRect(key: key, borderRadius: p.radius('borderRadius') ?? BorderRadius.zero, child: kid());
      case 'ClipRect':
        return ClipRect(key: key, child: kid());
      case 'ClipOval':
        return ClipOval(key: key, child: kid());
      case 'DecoratedBox':
        return DecoratedBox(key: key, decoration: p.decoration('decoration') ?? const BoxDecoration(), child: kid());
      case 'Table':
        return _table(p, raw);

      // ---- scrolling / slivers ---------------------------------------------
      case 'SingleChildScrollView':
        return SingleChildScrollView(key: key, scrollDirection: _axis(p.s('direction')), padding: p.edge('padding'), child: raw.isEmpty ? p.w('child') : kid());
      case 'ListView':
        return ListView(key: key, scrollDirection: _axis(p.s('direction')), padding: p.edge('padding'), shrinkWrap: p.hasB('shrinkWrap'), children: kids());
      case 'GridView':
        return GridView.count(key: key, crossAxisCount: p.i('crossAxisCount') ?? 2, mainAxisSpacing: p.d('mainAxisSpacing') ?? 0, crossAxisSpacing: p.d('crossAxisSpacing') ?? 0, childAspectRatio: p.d('childAspectRatio') ?? 1.0, padding: p.edge('padding'), children: kids());
      case 'PageView':
        return PageView(key: key, scrollDirection: _axis(p.s('direction')), onPageChanged: p.onInt('onPageChanged'), children: kids());
      case 'CustomScrollView':
        return CustomScrollView(key: key, slivers: kids());
      case 'ReorderableListView':
        return ReorderableListView(key: key, onReorder: p.onReorder('onReorder'), children: kids());
      case 'Scrollbar':
        return Scrollbar(key: key, child: kid());
      case 'SliverList':
        return SliverList(delegate: SliverChildListDelegate(kids()));
      case 'SliverToBoxAdapter':
        return SliverToBoxAdapter(key: key, child: kid());
      case 'SliverPadding':
        return SliverPadding(key: key, padding: p.edge('padding') ?? EdgeInsets.zero, sliver: kid());
      case 'SliverFillRemaining':
        return SliverFillRemaining(key: key, child: kid());
      case 'SliverGrid':
        return SliverGrid.count(crossAxisCount: p.i('crossAxisCount') ?? 2, children: kids());

      // ---- text / media -----------------------------------------------------
      case 'Text':
        return Text('${p.raw('data') ?? ''}', key: key, style: p.textStyle('style'), textAlign: _textAlign(p.s('align')), maxLines: p.i('maxLines'), overflow: _overflow(p.s('overflow')));
      case 'RichText':
        return RichText(key: key, text: TextSpan(text: '${p.raw('data') ?? ''}', style: p.textStyle('style')));
      case 'SelectableText':
        return SelectableText('${p.raw('data') ?? ''}', key: key, style: p.textStyle('style'), onSelectionChanged: null);
      case 'Icon':
        return Icon(_icon(p.s('name')), key: key, size: p.d('size') ?? (p.map('opts')?['size'] as num?)?.toDouble(), color: p.color('color'));
      case 'Image':
        return _image(p, key);
      case 'CircleAvatar':
        return CircleAvatar(key: key, radius: p.d('radius'), backgroundColor: p.color('backgroundColor'), child: p.w('child') ?? (p.has('label') ? Text('${p.raw('label')}') : null));

      // ---- buttons ----------------------------------------------------------
      case 'FilledButton':
        return FilledButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), onLongPress: p.onTap('onLongPress'), child: p.w('child') ?? Text('${p.raw('label') ?? ''}'));
      case 'ElevatedButton':
        return ElevatedButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), onLongPress: p.onTap('onLongPress'), child: p.w('child') ?? Text('${p.raw('label') ?? ''}'));
      case 'OutlinedButton':
        return OutlinedButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), child: p.w('child') ?? Text('${p.raw('label') ?? ''}'));
      case 'TextButton':
        return TextButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), onLongPress: p.onTap('onLongPress'), child: p.w('child') ?? Text('${p.raw('label') ?? ''}'));
      case 'IconButton':
        return IconButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), icon: p.w('icon') ?? Icon(_icon(p.s('name'))), tooltip: p.s('tooltip'));
      case 'FloatingActionButton':
        return FloatingActionButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), tooltip: p.s('tooltip'), child: p.w('child') ?? Icon(_icon(p.s('name') ?? 'add')));
      case 'PopupMenuButton':
        return _popupMenu(p, key);
      case 'SegmentedButton':
        return _segmentedButton(p, key);

      // ---- selection controls ----------------------------------------------
      case 'Switch':
        return Switch(key: key, value: p.b('value'), onChanged: p.onBool('onChanged'));
      case 'CupertinoSwitch':
        return CupertinoSwitch(key: key, value: p.b('value'), onChanged: p.onBool('onChanged'));
      case 'Checkbox':
        return Checkbox(key: key, value: p.b('value'), tristate: p.hasB('tristate'), onChanged: p.onBoolN('onChanged'));
      case 'Radio':
        return Radio(key: key, value: p.raw('value'), groupValue: p.raw('groupValue'), onChanged: p.onDynamic('onChanged'));
      case 'Slider':
        return Slider(key: key, value: (p.d('value') ?? 0.0), min: p.d('min') ?? 0.0, max: p.d('max') ?? 1.0, divisions: p.i('divisions'), label: p.s('label'), onChanged: p.onDouble('onChanged'), onChangeStart: p.onDouble('onChangeStart'), onChangeEnd: p.onDouble('onChangeEnd'));
      case 'RangeSlider':
        return RangeSlider(key: key, values: RangeValues(p.list('values')?[0]?.toDouble() ?? 0.0, p.list('values')?[1]?.toDouble() ?? 1.0), min: p.d('min') ?? 0.0, max: p.d('max') ?? 1.0, onChanged: p.onRange('onChanged'));
      case 'DropdownButton':
        return _dropdown(p, key);

      // ---- text input -------------------------------------------------------
      case 'TextField':
        return TextField(
          key: key,
          decoration: InputDecoration(hintText: p.s('hint'), labelText: p.s('label'), border: p.hasB('outlined') ? const OutlineInputBorder() : null),
          obscureText: p.hasB('obscure'),
          keyboardType: _keyboardType(p.s('keyboard')),
          maxLines: p.has('maxLines') ? p.i('maxLines') : 1,
          onChanged: p.onString('onChanged'),
          onSubmitted: p.onString('onSubmitted'),
          onEditingComplete: p.onTap('onEditingComplete'),
          onTap: p.onTap('onTap'),
        );
      case 'TextFormField':
        return TextFormField(
          key: key,
          decoration: InputDecoration(hintText: p.s('hint'), labelText: p.s('label')),
          onChanged: p.onString('onChanged'),
          onFieldSubmitted: p.onString('onSubmitted'),
          onSaved: p.onStringN('onSaved'),
        );

      // ---- material containers ---------------------------------------------
      case 'Card':
        return Card(key: key, color: p.color('color'), elevation: p.d('elevation'), margin: p.edge('margin'), child: raw.isEmpty ? p.w('child') : kid());
      case 'ListTile':
        return ListTile(
          key: key,
          leading: p.w('leading'),
          title: p.w('title') ?? (p.has('title') ? Text('${p.raw('title')}') : null),
          subtitle: p.w('subtitle') ?? (p.has('subtitle') ? Text('${p.raw('subtitle')}') : null),
          trailing: p.w('trailing'),
          onTap: p.onTap('onTap'),
          onLongPress: p.onTap('onLongPress'),
          selected: p.hasB('selected'),
        );
      case 'Chip':
        return Chip(key: key, label: p.w('label') ?? Text('${p.raw('label') ?? ''}'), avatar: p.w('avatar'), onDeleted: p.onTap('onDeleted'));
      case 'ActionChip':
        return ActionChip(key: key, label: p.w('label') ?? Text('${p.raw('label') ?? ''}'), onPressed: p.onTap('onPressed') ?? () {});
      case 'ChoiceChip':
        return ChoiceChip(key: key, label: p.w('label') ?? Text('${p.raw('label') ?? ''}'), selected: p.hasB('selected'), onSelected: p.onBool('onSelected'));
      case 'FilterChip':
        return FilterChip(key: key, label: p.w('label') ?? Text('${p.raw('label') ?? ''}'), selected: p.hasB('selected'), onSelected: p.onBool('onSelected'));
      case 'Badge':
        return Badge(key: key, label: p.has('label') ? Text('${p.raw('label')}') : null, child: kid());
      case 'Tooltip':
        return Tooltip(key: key, message: p.s('message') ?? '', child: kid());
      case 'Divider':
        return Divider(key: key, height: p.d('height'), thickness: p.d('thickness'), color: p.color('color'));
      case 'CircularProgressIndicator':
        return CircularProgressIndicator(key: key, value: p.d('value'), color: p.color('color'));
      case 'LinearProgressIndicator':
        return LinearProgressIndicator(key: key, value: p.d('value'), color: p.color('color'));
      case 'ExpansionTile':
        return ExpansionTile(key: key, title: p.w('title') ?? Text('${p.raw('title') ?? ''}'), onExpansionChanged: p.onBool('onExpansionChanged'), children: kids());
      case 'Stepper':
        return _stepper(p, key);
      case 'TabScaffold':
        return _tabScaffold(p, key);
      case 'Drawer':
        return Drawer(key: key, child: raw.isEmpty ? p.w('child') : kid());
      case 'BottomNavigationBar':
        return _bottomNav(p, key);
      case 'NavigationBar':
        return _navBar(p, key);

      // ---- cupertino --------------------------------------------------------
      case 'CupertinoButton':
        return CupertinoButton(key: key, onPressed: p.onTap('onTap') ?? p.onTap('onPressed'), child: p.w('child') ?? Text('${p.raw('label') ?? ''}'));
      case 'CupertinoNavigationBar':
        return CupertinoNavigationBar(key: key, middle: p.w('middle'));
      case 'CupertinoPageScaffold':
        return CupertinoPageScaffold(key: key, navigationBar: p.pref('navigationBar') as ObstructingPreferredSizeWidget?, child: p.w('child') ?? kid());
      case 'CupertinoTextField':
        return CupertinoTextField(key: key, placeholder: p.s('placeholder'), obscureText: p.hasB('obscure'), onChanged: p.onString('onChanged'), onSubmitted: p.onString('onSubmitted'));
      case 'CupertinoSlider':
        return CupertinoSlider(key: key, value: p.d('value') ?? 0.0, min: p.d('min') ?? 0.0, max: p.d('max') ?? 1.0, onChanged: p.onDouble('onChanged') ?? (_) {});
      case 'CupertinoActivityIndicator':
        return const CupertinoActivityIndicator();

      // ---- implicit animation ----------------------------------------------
      case 'AnimatedContainer':
        return AnimatedContainer(
          key: key,
          duration: p.duration('duration') ?? const Duration(milliseconds: 300),
          curve: _curve(p.s('curve')),
          alignment: p.align('alignment'),
          padding: p.edge('padding'),
          color: p.has('decoration') ? null : p.color('color'),
          width: p.d('width'),
          height: p.d('height'),
          decoration: p.decoration('decoration'),
          child: raw.isEmpty ? p.w('child') : kid(),
        );
      case 'AnimatedOpacity':
        return AnimatedOpacity(key: key, opacity: p.d('opacity') ?? 1.0, duration: p.duration('duration') ?? const Duration(milliseconds: 300), child: kid());
      case 'AnimatedPadding':
        return AnimatedPadding(key: key, padding: p.edge('padding') ?? EdgeInsets.zero, duration: p.duration('duration') ?? const Duration(milliseconds: 300), child: kid());
      case 'AnimatedAlign':
        return AnimatedAlign(key: key, alignment: p.align('alignment') ?? Alignment.center, duration: p.duration('duration') ?? const Duration(milliseconds: 300), child: kid());
      case 'AnimatedSwitcher':
        return AnimatedSwitcher(key: key, duration: p.duration('duration') ?? const Duration(milliseconds: 300), child: kid());
      case 'Hero':
        return Hero(key: key, tag: p.raw('tag') ?? 'hero', child: kid());

      // ---- custom painting --------------------------------------------------
      case 'CustomPaint':
        final size = p.list('size');
        return CustomPaint(
          key: key,
          size: size != null && size.length >= 2 ? Size((size[0] as num).toDouble(), (size[1] as num).toDouble()) : Size.zero,
          painter: p.has('ops') ? _ReplayPainter(p.list('ops')!) : null,
          foregroundPainter: p.has('foregroundOps') ? _ReplayPainter(p.list('foregroundOps')!) : null,
          isComplex: p.hasB('isComplex'),
          willChange: p.hasB('willChange'),
          child: p.w('child'),
        );

      // ---- EVENT wrappers (the full event surface) -------------------------
      case 'GestureDetector':
        return _gestureDetector(p, key);
      case 'InkWell':
        return _inkWell(p, key);
      case 'Listener':
        return _listener(p, key);
      case 'MouseRegion':
        return _mouseRegion(p, key);
      case 'Focus':
        return _focus(p, key);
      case 'KeyboardListener':
        return _keyboardListener(p, key);
      case 'NotificationListener':
        return _notificationListener(p, key);
      case 'Draggable':
        return _draggable(p, key);
      case 'DragTarget':
        return _dragTarget(p, key);
      case 'Dismissible':
        return _dismissible(p, key);
      case 'RefreshIndicator':
        return RefreshIndicator(key: key, onRefresh: () async => p.fireVoid('onRefresh'), child: p.w('child') ?? const SizedBox());
      case 'PopScope':
        return PopScope(key: key, canPop: p.has('canPop') ? p.b('canPop') : true, onPopInvoked: (didPop) => p.fire('onPopInvoked', [didPop]), child: p.w('child') ?? const SizedBox());
      case 'Form':
        return Form(key: key, onChanged: p.onTap('onChanged'), child: p.w('child') ?? const SizedBox());

      default:
        // Any type not in the hand-written catalog above falls through to the
        // generated registry (the full public widget API). The stub returns
        // null until the generator has run; then this reaches everything.
        return buildGenerated(type, p, raw, key, this) ?? const SizedBox.shrink();
    }
  }

  // ===========================================================================
  // EVENT wiring — every callback becomes a closure that serializes its details
  // to JSON and fires the guest callable.
  // ===========================================================================

  Widget _gestureDetector(_P p, Key? key) {
    return GestureDetector(
      key: key,
      behavior: HitTestBehavior.opaque,
      onTapDown: p.on('onTapDown', (d) => _tapDown(d)),
      onTapUp: p.on('onTapUp', (d) => _tapUp(d)),
      onTap: p.onTap('onTap'),
      onTapCancel: p.onTap('onTapCancel'),
      onSecondaryTap: p.onTap('onSecondaryTap'),
      onSecondaryTapDown: p.on('onSecondaryTapDown', (d) => _tapDown(d)),
      onSecondaryTapUp: p.on('onSecondaryTapUp', (d) => _tapUp(d)),
      onSecondaryTapCancel: p.onTap('onSecondaryTapCancel'),
      onTertiaryTapDown: p.on('onTertiaryTapDown', (d) => _tapDown(d)),
      onTertiaryTapUp: p.on('onTertiaryTapUp', (d) => _tapUp(d)),
      onTertiaryTapCancel: p.onTap('onTertiaryTapCancel'),
      onDoubleTap: p.onTap('onDoubleTap'),
      onDoubleTapDown: p.on('onDoubleTapDown', (d) => _tapDown(d)),
      onDoubleTapCancel: p.onTap('onDoubleTapCancel'),
      onLongPress: p.onTap('onLongPress'),
      onLongPressStart: p.on('onLongPressStart', (d) => _pos(d.globalPosition, d.localPosition)),
      onLongPressMoveUpdate: p.on('onLongPressMoveUpdate', (d) => _pos(d.globalPosition, d.localPosition)),
      onLongPressUp: p.onTap('onLongPressUp'),
      onLongPressEnd: p.on('onLongPressEnd', (d) => _pos(d.globalPosition, d.localPosition)),
      onVerticalDragStart: p.on('onVerticalDragStart', (d) => _pos(d.globalPosition, d.localPosition)),
      onVerticalDragUpdate: p.on('onVerticalDragUpdate', (d) => _drag(d)),
      onVerticalDragEnd: p.on('onVerticalDragEnd', (d) => _dragEnd(d)),
      onVerticalDragDown: p.on('onVerticalDragDown', (d) => _pos(d.globalPosition, d.localPosition)),
      onVerticalDragCancel: p.onTap('onVerticalDragCancel'),
      onHorizontalDragStart: p.on('onHorizontalDragStart', (d) => _pos(d.globalPosition, d.localPosition)),
      onHorizontalDragUpdate: p.on('onHorizontalDragUpdate', (d) => _drag(d)),
      onHorizontalDragEnd: p.on('onHorizontalDragEnd', (d) => _dragEnd(d)),
      onHorizontalDragDown: p.on('onHorizontalDragDown', (d) => _pos(d.globalPosition, d.localPosition)),
      onHorizontalDragCancel: p.onTap('onHorizontalDragCancel'),
      onPanStart: p.on('onPanStart', (d) => _pos(d.globalPosition, d.localPosition)),
      onPanUpdate: p.on('onPanUpdate', (d) => _drag(d)),
      onPanEnd: p.on('onPanEnd', (d) => _dragEnd(d)),
      onPanDown: p.on('onPanDown', (d) => _pos(d.globalPosition, d.localPosition)),
      onPanCancel: p.onTap('onPanCancel'),
      onScaleStart: p.on('onScaleStart', (d) => {'focalX': d.focalPoint.dx, 'focalY': d.focalPoint.dy, 'pointerCount': d.pointerCount}),
      onScaleUpdate: p.on('onScaleUpdate', (d) => {'scale': d.scale, 'rotation': d.rotation, 'focalX': d.focalPoint.dx, 'focalY': d.focalPoint.dy, 'pointerCount': d.pointerCount}),
      onScaleEnd: p.on('onScaleEnd', (d) => {'velocity': d.velocity.pixelsPerSecond.distance, 'pointerCount': d.pointerCount}),
      onForcePressStart: p.on('onForcePressStart', (d) => {'x': d.globalPosition.dx, 'y': d.globalPosition.dy, 'pressure': d.pressure}),
      onForcePressPeak: p.on('onForcePressPeak', (d) => {'pressure': d.pressure}),
      onForcePressUpdate: p.on('onForcePressUpdate', (d) => {'pressure': d.pressure}),
      onForcePressEnd: p.on('onForcePressEnd', (d) => {'pressure': d.pressure}),
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _inkWell(_P p, Key? key) {
    return InkWell(
      key: key,
      onTap: p.onTap('onTap'),
      onTapDown: p.on('onTapDown', (d) => _tapDown(d)),
      onTapUp: p.on('onTapUp', (d) => _tapUp(d)),
      onTapCancel: p.onTap('onTapCancel'),
      onDoubleTap: p.onTap('onDoubleTap'),
      onLongPress: p.onTap('onLongPress'),
      onSecondaryTap: p.onTap('onSecondaryTap'),
      onHover: p.onBool('onHover'),
      onFocusChange: p.onBool('onFocusChange'),
      onHighlightChanged: p.onBool('onHighlightChanged'),
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _listener(_P p, Key? key) {
    return Listener(
      key: key,
      behavior: HitTestBehavior.opaque,
      onPointerDown: p.on('onPointerDown', (e) => _pointer(e)),
      onPointerMove: p.on('onPointerMove', (e) => _pointer(e)),
      onPointerUp: p.on('onPointerUp', (e) => _pointer(e)),
      onPointerHover: p.on('onPointerHover', (e) => _pointer(e)),
      onPointerCancel: p.on('onPointerCancel', (e) => _pointer(e)),
      onPointerSignal: p.on('onPointerSignal', (e) => _pointer(e)),
      onPointerPanZoomStart: p.on('onPointerPanZoomStart', (e) => _pointer(e)),
      onPointerPanZoomUpdate: p.on('onPointerPanZoomUpdate', (e) => _pointer(e)),
      onPointerPanZoomEnd: p.on('onPointerPanZoomEnd', (e) => _pointer(e)),
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _mouseRegion(_P p, Key? key) {
    return MouseRegion(
      key: key,
      onEnter: p.on('onEnter', (e) => _pointer(e)),
      onExit: p.on('onExit', (e) => _pointer(e)),
      onHover: p.on('onHover', (e) => _pointer(e)),
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _focus(_P p, Key? key) {
    return Focus(
      key: key,
      autofocus: p.hasB('autofocus'),
      onFocusChange: p.onBool('onFocusChange'),
      onKeyEvent: p.has('onKeyEvent')
          ? (node, event) {
              p.fire('onKeyEvent', [_keyEvent(event)]);
              return KeyEventResult.ignored;
            }
          : null,
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _keyboardListener(_P p, Key? key) {
    return KeyboardListener(
      key: key,
      focusNode: FocusNode(),
      autofocus: p.hasB('autofocus'),
      onKeyEvent: (event) => p.fire('onKeyEvent', [_keyEvent(event)]),
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _notificationListener(_P p, Key? key) {
    return NotificationListener<Notification>(
      key: key,
      onNotification: (n) {
        p.fire('onNotification', [_notification(n)]);
        return false;
      },
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _draggable(_P p, Key? key) {
    return Draggable<Object>(
      key: key,
      data: p.raw('data') ?? 0,
      feedback: p.w('feedback') ?? const SizedBox(),
      childWhenDragging: p.w('childWhenDragging'),
      onDragStarted: p.onTap('onDragStarted'),
      onDragUpdate: p.on('onDragUpdate', (d) => _pos(d.globalPosition, d.localPosition)),
      onDragEnd: p.on('onDragEnd', (d) => {'x': d.offset.dx, 'y': d.offset.dy, 'velocityX': d.velocity.pixelsPerSecond.dx, 'velocityY': d.velocity.pixelsPerSecond.dy}),
      onDraggableCanceled: p.has('onDraggableCanceled') ? (v, o) => p.fire('onDraggableCanceled', [{'x': o.dx, 'y': o.dy}]) : null,
      onDragCompleted: p.onTap('onDragCompleted'),
      child: p.w('child') ?? const SizedBox(),
    );
  }

  Widget _dragTarget(_P p, Key? key) {
    return DragTarget<Object>(
      key: key,
      onWillAcceptWithDetails: p.has('onWillAccept') ? (d) { p.fire('onWillAccept', [d.data]); return true; } : null,
      onAcceptWithDetails: p.has('onAccept') ? (d) => p.fire('onAccept', [d.data]) : null,
      onLeave: p.has('onLeave') ? (d) => p.fire('onLeave', [d]) : null,
      onMove: p.has('onMove') ? (d) => p.fire('onMove', [{'x': d.offset.dx, 'y': d.offset.dy}]) : null,
      builder: (context, candidate, rejected) => p.w('child') ?? const SizedBox(),
    );
  }

  Widget _dismissible(_P p, Key? key) {
    return Dismissible(
      key: ValueKey(p.raw('dismissKey') ?? UniqueKey()),
      onDismissed: (dir) => p.fire('onDismissed', [dir.name]),
      onResize: p.onTap('onResize'),
      onUpdate: p.has('onUpdate') ? (d) => p.fire('onUpdate', [{'progress': d.progress, 'reached': d.reached}]) : null,
      confirmDismiss: p.has('confirmDismiss') ? (dir) async { p.fire('confirmDismiss', [dir.name]); return true; } : null,
      child: p.w('child') ?? const SizedBox(),
    );
  }

  // ---- event detail serializers --------------------------------------------

  Map<String, dynamic> _pos(Offset global, Offset local) =>
      {'globalX': global.dx, 'globalY': global.dy, 'localX': local.dx, 'localY': local.dy};
  Map<String, dynamic> _tapDown(TapDownDetails d) => _pos(d.globalPosition, d.localPosition);
  Map<String, dynamic> _tapUp(TapUpDetails d) => _pos(d.globalPosition, d.localPosition);
  Map<String, dynamic> _drag(DragUpdateDetails d) =>
      {'dx': d.delta.dx, 'dy': d.delta.dy, 'primaryDelta': d.primaryDelta, 'globalX': d.globalPosition.dx, 'globalY': d.globalPosition.dy, 'localX': d.localPosition.dx, 'localY': d.localPosition.dy};
  Map<String, dynamic> _dragEnd(DragEndDetails d) =>
      {'velocityX': d.velocity.pixelsPerSecond.dx, 'velocityY': d.velocity.pixelsPerSecond.dy, 'primaryVelocity': d.primaryVelocity};
  Map<String, dynamic> _pointer(PointerEvent e) => {
        'x': e.position.dx,
        'y': e.position.dy,
        'localX': e.localPosition.dx,
        'localY': e.localPosition.dy,
        'dx': e.delta.dx,
        'dy': e.delta.dy,
        'buttons': e.buttons,
        'pressure': e.pressure,
        'kind': e.kind.name,
        'device': e.device,
      };
  Map<String, dynamic> _keyEvent(KeyEvent e) => {
        'logicalKey': e.logicalKey.keyLabel,
        'logicalKeyId': e.logicalKey.keyId,
        'physicalKey': e.physicalKey.debugName ?? '',
        'character': e.character,
        'isDown': e is KeyDownEvent,
        'isUp': e is KeyUpEvent,
        'isRepeat': e is KeyRepeatEvent,
      };
  Map<String, dynamic> _notification(Notification n) {
    if (n is ScrollNotification) {
      return {'kind': n.runtimeType.toString(), 'pixels': n.metrics.pixels, 'maxScrollExtent': n.metrics.maxScrollExtent, 'axis': n.metrics.axis.name};
    }
    return {'kind': n.runtimeType.toString()};
  }

  // ===========================================================================
  // Composite widget builders that need more than a one-liner.
  // ===========================================================================

  Widget _image(_P p, Key? key) {
    final src = '${p.raw('src') ?? ''}';
    final opts = p.map('opts') ?? const {};
    final w = (opts['width'] as num?)?.toDouble();
    final h = (opts['height'] as num?)?.toDouble();
    final fit = _boxFit(opts['fit'] as String?);
    if (src.startsWith('http')) return Image.network(src, key: key, width: w, height: h, fit: fit);
    if (src.startsWith('data:')) return Image.memory(base64Decode(src.substring(src.indexOf(',') + 1)), key: key, width: w, height: h, fit: fit);
    return Image.asset(src, key: key, width: w, height: h, fit: fit);
  }

  Widget _dropdown(_P p, Key? key) {
    final items = (p.list('items') ?? const []).map((e) => '$e').toList();
    return DropdownButton<String>(
      key: key,
      value: p.has('value') ? '${p.raw('value')}' : null,
      items: items.map((s) => DropdownMenuItem<String>(value: s, child: Text(s))).toList(),
      onChanged: p.has('onChanged') ? (v) => p.fire('onChanged', [v]) : null,
    );
  }

  Widget _popupMenu(_P p, Key? key) {
    final items = (p.list('items') ?? const []).map((e) => '$e').toList();
    return PopupMenuButton<String>(
      key: key,
      onSelected: (v) => p.fire('onSelected', [v]),
      itemBuilder: (_) => items.map((s) => PopupMenuItem<String>(value: s, child: Text(s))).toList(),
      child: p.w('child'),
    );
  }

  Widget _segmentedButton(_P p, Key? key) {
    final segs = (p.list('segments') ?? const []).map((e) => '$e').toList();
    final selected = (p.list('selected') ?? const []).map((e) => '$e').toSet();
    return SegmentedButton<String>(
      key: key,
      segments: segs.map((s) => ButtonSegment<String>(value: s, label: Text(s))).toList(),
      selected: selected.isEmpty && segs.isNotEmpty ? {segs.first} : selected,
      multiSelectionEnabled: p.hasB('multi'),
      onSelectionChanged: (sel) => p.fire('onSelectionChanged', [sel.toList()]),
    );
  }

  Widget _stepper(_P p, Key? key) {
    final steps = (p.list('steps') ?? const []).map((e) {
      final m = e as Map? ?? const {};
      return Step(title: Text('${m['title'] ?? ''}'), content: build(m['content']));
    }).toList();
    return Stepper(key: key, currentStep: p.i('currentStep') ?? 0, onStepTapped: p.onInt('onStepTapped'), onStepContinue: p.onTap('onStepContinue'), onStepCancel: p.onTap('onStepCancel'), steps: steps);
  }

  Widget _tabScaffold(_P p, Key? key) {
    final tabs = (p.list('tabs') ?? const []).map((e) => '$e').toList();
    final views = (p.wl('views') ?? const <Widget>[]);
    return DefaultTabController(
      key: key,
      length: tabs.length,
      child: Column(children: [
        TabBar(tabs: tabs.map((t) => Tab(text: t)).toList(), onTap: p.onInt('onTap')),
        Expanded(child: TabBarView(children: views)),
      ]),
    );
  }

  Widget _bottomNav(_P p, Key? key) {
    final items = (p.list('items') ?? const []).map((e) {
      final m = e as Map? ?? const {};
      return BottomNavigationBarItem(icon: Icon(_icon(m['icon'] as String?)), label: '${m['label'] ?? ''}');
    }).toList();
    return BottomNavigationBar(key: key, currentIndex: p.i('currentIndex') ?? 0, onTap: p.onInt('onTap'), type: BottomNavigationBarType.fixed, items: items.length >= 2 ? items : [const BottomNavigationBarItem(icon: Icon(Icons.circle), label: '')]);
  }

  Widget _navBar(_P p, Key? key) {
    final items = (p.list('items') ?? const []).map((e) {
      final m = e as Map? ?? const {};
      return NavigationDestination(icon: Icon(_icon(m['icon'] as String?)), label: '${m['label'] ?? ''}');
    }).toList();
    return NavigationBar(key: key, selectedIndex: p.i('selectedIndex') ?? 0, onDestinationSelected: p.onInt('onDestinationSelected'), destinations: items.length >= 2 ? items : [const NavigationDestination(icon: Icon(Icons.circle), label: '')]);
  }

  Widget _table(_P p, List rows) {
    return Table(children: rows.map((r) {
      final cells = (r is Map ? (r['c'] as List? ?? const []) : (r as List? ?? const []));
      return TableRow(children: cells.map<Widget>((c) => build(c)).toList());
    }).toList());
  }

  // ===========================================================================
  // Value decoders (enums, geometry, paint). Extended by the generator.
  // ===========================================================================

  Key? _key(dynamic v) => v == null ? null : ValueKey('$v');

  IconData _icon(String? name) => _iconTable[name] ?? Icons.circle;
}

// A props accessor bound to one interpreter (so handlers can fire events).
class _P {
  _P(this.m, this.it);
  final Map m;
  final _Interp it;

  bool has(String k) => m.containsKey(k) && m[k] != null;
  bool hasB(String k) => m[k] == true;
  dynamic raw(String k) => m[k];
  Map? map(String k) => m[k] is Map ? m[k] as Map : null;
  List? list(String k) => m[k] is List ? m[k] as List : null;
  String? s(String k) => m[k] == null ? null : '${m[k]}';
  bool b(String k) => m[k] == true;
  int? i(String k) => m[k] is num ? (m[k] as num).toInt() : null;
  double? d(String k) => m[k] is num ? (m[k] as num).toDouble() : null;

  Widget? w(String k) => has(k) ? it.build(m[k]) : null;
  List<Widget>? wl(String k) => list(k)?.map<Widget>((e) => it.build(e)).toList();
  PreferredSizeWidget? pref(String k) {
    final built = w(k);
    if (built is PreferredSizeWidget) return built;
    if (built == null) return null;
    return PreferredSize(preferredSize: const Size.fromHeight(kToolbarHeight), child: built);
  }

  // ---- handler decoders (each converts a `{callable}` tag to a typed cb) ----
  int? _cb(String k) => (m[k] is Map && (m[k] as Map)['callable'] is int) ? (m[k] as Map)['callable'] as int : null;
  void fire(String k, List<dynamic> args) {
    final id = _cb(k);
    if (id != null) it.fire(id, args);
  }
  void fireVoid(String k) => fire(k, const []);

  VoidCallback? onTap(String k) => _cb(k) == null ? null : () => fire(k, const []);
  ValueChanged<bool>? onBool(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<bool?>? onBoolN(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<double>? onDouble(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<int>? onInt(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<String>? onString(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<String?>? onStringN(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<Object?>? onDynamic(String k) => _cb(k) == null ? null : (v) => fire(k, [v]);
  ValueChanged<RangeValues>? onRange(String k) => _cb(k) == null ? null : (v) => fire(k, [[v.start, v.end]]);
  ReorderCallback onReorder(String k) => (oldI, newI) => fire(k, [oldI, newI]);

  // Generic: build a typed callback from a details->json serializer.
  T? on<T extends Object?>(String k, dynamic Function(dynamic) serialize) {
    if (_cb(k) == null) return null;
    return ((dynamic details) => fire(k, [serialize(details)])) as T;
  }

  // ---- value decoders -------------------------------------------------------
  EdgeInsets? edge(String k) {
    final v = m[k];
    if (v == null) return null;
    if (v is num) return EdgeInsets.all(v.toDouble());
    if (v is List && v.length == 4) return EdgeInsets.fromLTRB((v[0] as num).toDouble(), (v[1] as num).toDouble(), (v[2] as num).toDouble(), (v[3] as num).toDouble());
    if (v is Map) return EdgeInsets.only(left: (v['left'] as num?)?.toDouble() ?? 0, top: (v['top'] as num?)?.toDouble() ?? 0, right: (v['right'] as num?)?.toDouble() ?? 0, bottom: (v['bottom'] as num?)?.toDouble() ?? 0);
    return null;
  }

  Color? color(String k) => _decodeColor(m[k]);

  Alignment? align(String k) {
    final v = m[k];
    if (v is List && v.length == 2) return Alignment((v[0] as num).toDouble(), (v[1] as num).toDouble());
    return _alignTable[s(k)];
  }

  BoxConstraints? constraints(String k) {
    final v = map(k);
    if (v == null) return null;
    return BoxConstraints(minWidth: (v['minWidth'] as num?)?.toDouble() ?? 0, maxWidth: (v['maxWidth'] as num?)?.toDouble() ?? double.infinity, minHeight: (v['minHeight'] as num?)?.toDouble() ?? 0, maxHeight: (v['maxHeight'] as num?)?.toDouble() ?? double.infinity);
  }

  BorderRadius? radius(String k) {
    final v = m[k];
    if (v is num) return BorderRadius.circular(v.toDouble());
    return null;
  }

  Duration? duration(String k) {
    final v = m[k];
    if (v is num) return Duration(milliseconds: v.toInt());
    return null;
  }

  Matrix4? matrix(String k) {
    final v = list(k);
    if (v != null && v.length == 16) return Matrix4.fromList(v.map((e) => (e as num).toDouble()).toList());
    return null;
  }

  TextStyle? textStyle(String k) {
    final v = map(k);
    if (v == null) return null;
    return TextStyle(
      fontSize: (v['size'] as num?)?.toDouble(),
      fontWeight: v['bold'] == true ? FontWeight.bold : _weight(v['weight'] as String?),
      fontStyle: v['italic'] == true ? FontStyle.italic : null,
      color: _decodeColor(v['color']),
      letterSpacing: (v['letterSpacing'] as num?)?.toDouble(),
      height: (v['height'] as num?)?.toDouble(),
      decoration: v['underline'] == true ? TextDecoration.underline : null,
    );
  }

  BoxDecoration? decoration(String k) {
    final v = map(k);
    if (v == null) return null;
    return BoxDecoration(
      color: _decodeColor(v['color']),
      borderRadius: v['radius'] is num ? BorderRadius.circular((v['radius'] as num).toDouble()) : null,
      border: v['border'] != null ? Border.all(color: _decodeColor((v['border'] as Map?)?['color']) ?? Colors.black, width: ((v['border'] as Map?)?['width'] as num?)?.toDouble() ?? 1.0) : null,
      shape: v['shape'] == 'circle' ? BoxShape.circle : BoxShape.rectangle,
      gradient: _gradient(v['gradient']),
    );
  }
}

// =============================================================================
// Canvas / CustomPainter — replay a serialized dart:ui display list onto the
// real Flutter Canvas. Every Canvas / Paint / Path / shader / paragraph op the
// guest FLCanvas can record is handled here.
// =============================================================================

// Fires when an async image finishes decoding so painters holding it repaint.
final ValueNotifier<int> _canvasRepaint = ValueNotifier<int>(0);
final Map<String, ui.Image> _imageCache = {};
final Set<String> _imageLoading = {};

class _ReplayPainter extends CustomPainter {
  _ReplayPainter(this.ops) : super(repaint: _canvasRepaint);
  final List ops;

  @override
  void paint(Canvas canvas, Size size) {
    for (final raw in ops) {
      if (raw is! Map) continue;
      _apply(canvas, raw, size);
    }
  }

  void _apply(Canvas canvas, Map o, Size size) {
    switch (o['op'] as String? ?? '') {
      case 'save':
        canvas.save();
        break;
      case 'saveLayer':
        canvas.saveLayer(_rectN(o['rect']), _paint(o['paint']));
        break;
      case 'restore':
        canvas.restore();
        break;
      case 'restoreToCount':
        canvas.restoreToCount(_int(o['count']) ?? 1);
        break;
      case 'translate':
        canvas.translate(_d(o['dx']), _d(o['dy']));
        break;
      case 'scale':
        canvas.scale(_d(o['sx']), _d(o['sy']));
        break;
      case 'rotate':
        canvas.rotate(_d(o['radians']));
        break;
      case 'skew':
        canvas.skew(_d(o['sx']), _d(o['sy']));
        break;
      case 'transform':
        canvas.transform(_float64(o['matrix']));
        break;
      case 'clipRect':
        canvas.clipRect(_rect(o['rect']), clipOp: o['clipOp'] == 'difference' ? ui.ClipOp.difference : ui.ClipOp.intersect, doAntiAlias: o['aa'] != false);
        break;
      case 'clipRRect':
        canvas.clipRRect(_rrect(o['rrect']), doAntiAlias: o['aa'] != false);
        break;
      case 'clipPath':
        canvas.clipPath(_path(o['path']), doAntiAlias: o['aa'] != false);
        break;
      case 'drawColor':
        canvas.drawColor(_decodeColor(o['color']) ?? const Color(0x00000000), _blend(o['blend']));
        break;
      case 'drawPaint':
        canvas.drawPaint(_paint(o['paint']));
        break;
      case 'drawLine':
        canvas.drawLine(_off(o['p1']), _off(o['p2']), _paint(o['paint']));
        break;
      case 'drawRect':
        canvas.drawRect(_rect(o['rect']), _paint(o['paint']));
        break;
      case 'drawRRect':
        canvas.drawRRect(_rrect(o['rrect']), _paint(o['paint']));
        break;
      case 'drawDRRect':
        canvas.drawDRRect(_rrect(o['outer']), _rrect(o['inner']), _paint(o['paint']));
        break;
      case 'drawOval':
        canvas.drawOval(_rect(o['rect']), _paint(o['paint']));
        break;
      case 'drawCircle':
        canvas.drawCircle(Offset(_d(o['cx']), _d(o['cy'])), _d(o['radius']), _paint(o['paint']));
        break;
      case 'drawArc':
        canvas.drawArc(_rect(o['rect']), _d(o['start']), _d(o['sweep']), o['useCenter'] == true, _paint(o['paint']));
        break;
      case 'drawPath':
        canvas.drawPath(_path(o['path']), _paint(o['paint']));
        break;
      case 'drawImage':
        final img = _image(o['src']);
        if (img != null) canvas.drawImage(img, _off2(o['dx'], o['dy']), _paint(o['paint']));
        break;
      case 'drawImageRect':
        final img = _image(o['src']);
        if (img != null) canvas.drawImageRect(img, _rect(o['srcRect']), _rect(o['dstRect']), _paint(o['paint']));
        break;
      case 'drawImageNine':
        final img = _image(o['src']);
        if (img != null) canvas.drawImageNine(img, _rect(o['center']), _rect(o['dstRect']), _paint(o['paint']));
        break;
      case 'drawParagraph':
        canvas.drawParagraph(_paragraph(o['paragraph']), _off2(o['dx'], o['dy']));
        break;
      case 'drawPoints':
        canvas.drawPoints(_pointMode(o['mode']), _offsets(o['points']), _paint(o['paint']));
        break;
      case 'drawShadow':
        canvas.drawShadow(_path(o['path']), _decodeColor(o['color']) ?? const Color(0xFF000000), _d(o['elevation']), o['transparentOccluder'] == true);
        break;
      case 'drawVertices':
        canvas.drawVertices(_vertices(o['vertices']), _blend(o['blend']), _paint(o['paint']));
        break;
      case 'drawAtlas':
        final img = _image(o['src']);
        if (img != null) {
          canvas.drawAtlas(img, _rsTransforms(o['transforms']), _rects(o['rects']), _colors(o['colors']), _blend(o['blend']), _rectN(o['cullRect']), _paint(o['paint']));
        }
        break;
    }
  }

  @override
  bool shouldRepaint(covariant _ReplayPainter old) => !identical(old.ops, ops);

  // ---- canvas value decoders ------------------------------------------------
  double _d(dynamic v) => v is num ? v.toDouble() : 0.0;
  int? _int(dynamic v) => v is num ? v.toInt() : null;
  Offset _off(dynamic v) => v is List && v.length >= 2 ? Offset(_d(v[0]), _d(v[1])) : Offset.zero;
  Offset _off2(dynamic x, dynamic y) => Offset(_d(x), _d(y));
  Rect _rect(dynamic v) => v is List && v.length >= 4 ? Rect.fromLTRB(_d(v[0]), _d(v[1]), _d(v[2]), _d(v[3])) : Rect.zero;
  Rect? _rectN(dynamic v) => v == null ? null : _rect(v);
  Float64List _float64(dynamic v) => v is List ? Float64List.fromList(v.map((e) => (e as num).toDouble()).toList()) : Matrix4.identity().storage;

  RRect _rrect(dynamic v) {
    if (v is! Map) return RRect.fromRectAndRadius(_rect(v), Radius.zero);
    final r = _rect(v['rect']);
    if (v['radius'] is num) return RRect.fromRectAndRadius(r, Radius.circular((v['radius'] as num).toDouble()));
    Radius corner(String k) => v[k] is num ? Radius.circular((v[k] as num).toDouble()) : Radius.zero;
    return RRect.fromRectAndCorners(r, topLeft: corner('tl'), topRight: corner('tr'), bottomLeft: corner('bl'), bottomRight: corner('br'));
  }

  List<Offset> _offsets(dynamic v) => v is List ? v.map<Offset>((e) => _off(e)).toList() : const [];

  Paint _paint(dynamic v) {
    final paint = Paint();
    if (v is! Map) return paint;
    paint.color = _decodeColor(v['color']) ?? const Color(0xFF000000);
    if (v['style'] == 'stroke') paint.style = PaintingStyle.stroke;
    if (v['strokeWidth'] is num) paint.strokeWidth = (v['strokeWidth'] as num).toDouble();
    paint.strokeCap = _strokeCap(v['strokeCap']);
    paint.strokeJoin = _strokeJoin(v['strokeJoin']);
    if (v['strokeMiterLimit'] is num) paint.strokeMiterLimit = (v['strokeMiterLimit'] as num).toDouble();
    if (v['isAntiAlias'] is bool) paint.isAntiAlias = v['isAntiAlias'] as bool;
    if (v['blendMode'] != null) paint.blendMode = _blend(v['blendMode']);
    if (v['invertColors'] == true) paint.invertColors = true;
    if (v['shader'] != null) paint.shader = _shader(v['shader']);
    final blurSigma = v['blur'] is num ? (v['blur'] as num).toDouble() : (v['maskFilter'] is Map && (v['maskFilter']['sigma'] is num) ? (v['maskFilter']['sigma'] as num).toDouble() : null);
    if (blurSigma != null) paint.maskFilter = MaskFilter.blur(_blurStyle(v['maskFilter'] is Map ? v['maskFilter']['style'] : null), blurSigma);
    return paint;
  }

  Path _path(dynamic v) {
    final path = Path();
    if (v is! Map) return path;
    if (v['fillType'] == 'evenOdd') path.fillType = PathFillType.evenOdd;
    for (final verb in (v['verbs'] as List? ?? const [])) {
      if (verb is! List || verb.isEmpty) continue;
      final n = verb.map((e) => e is num ? e.toDouble() : e).toList();
      switch (verb[0]) {
        case 'moveTo': path.moveTo(n[1], n[2]); break;
        case 'lineTo': path.lineTo(n[1], n[2]); break;
        case 'rMoveTo': path.relativeMoveTo(n[1], n[2]); break;
        case 'rLineTo': path.relativeLineTo(n[1], n[2]); break;
        case 'quadTo': path.quadraticBezierTo(n[1], n[2], n[3], n[4]); break;
        case 'rQuadTo': path.relativeQuadraticBezierTo(n[1], n[2], n[3], n[4]); break;
        case 'cubicTo': path.cubicTo(n[1], n[2], n[3], n[4], n[5], n[6]); break;
        case 'rCubicTo': path.relativeCubicTo(n[1], n[2], n[3], n[4], n[5], n[6]); break;
        case 'conicTo': path.conicTo(n[1], n[2], n[3], n[4], n[5]); break;
        case 'rConicTo': path.relativeConicTo(n[1], n[2], n[3], n[4], n[5]); break;
        case 'arcTo': path.arcTo(_rect(verb[1]), (verb[2] as num).toDouble(), (verb[3] as num).toDouble(), verb[4] == true); break;
        case 'arcToPoint': path.arcToPoint(Offset((verb[1] as num).toDouble(), (verb[2] as num).toDouble()), radius: Radius.elliptical((verb[3] as num).toDouble(), (verb[4] as num).toDouble()), rotation: (verb[5] as num).toDouble(), largeArc: verb[6] == true, clockwise: verb[7] != false); break;
        case 'addRect': path.addRect(_rect(verb[1])); break;
        case 'addRRect': path.addRRect(_rrect(verb[1])); break;
        case 'addOval': path.addOval(_rect(verb[1])); break;
        case 'addArc': path.addArc(_rect(verb[1]), (verb[2] as num).toDouble(), (verb[3] as num).toDouble()); break;
        case 'addPolygon': path.addPolygon(_offsets(verb[1]), verb[2] == true); break;
        case 'addPath': path.addPath(_path(verb[1]), Offset((verb[2] as num).toDouble(), (verb[3] as num).toDouble())); break;
        case 'close': path.close(); break;
      }
    }
    return path;
  }

  ui.Shader? _shader(dynamic v) {
    if (v is! Map) return null;
    final colors = (v['colors'] as List? ?? const []).map((c) => _decodeColor(c) ?? const Color(0xFF000000)).toList();
    final stops = v['stops'] is List ? (v['stops'] as List).map((e) => (e as num).toDouble()).toList() : null;
    if (colors.length < 2) return null;
    switch (v['type']) {
      case 'linear':
        return ui.Gradient.linear(_off(v['from']), _off(v['to']), colors, stops, _tileMode(v['tileMode']));
      case 'radial':
        return ui.Gradient.radial(_off(v['center']), _d(v['radius']), colors, stops, _tileMode(v['tileMode']));
      case 'sweep':
        return ui.Gradient.sweep(_off(v['center']), colors, stops, _tileMode(v['tileMode']), _d(v['startAngle']), v['endAngle'] is num ? (v['endAngle'] as num).toDouble() : 6.2831853);
      default:
        return null;
    }
  }

  ui.Paragraph _paragraph(dynamic v) {
    final m = v is Map ? v : const {};
    final style = m['style'] is Map ? m['style'] as Map : const {};
    final builder = ui.ParagraphBuilder(ui.ParagraphStyle(
      textAlign: _textAlign(style['align'] as String? ?? m['align'] as String?),
      fontSize: (style['size'] as num?)?.toDouble(),
      fontWeight: style['bold'] == true ? FontWeight.bold : null,
    ))
      ..pushStyle(ui.TextStyle(color: _decodeColor(style['color']) ?? const Color(0xFF000000), fontSize: (style['size'] as num?)?.toDouble()))
      ..addText('${m['text'] ?? ''}');
    final para = builder.build();
    para.layout(ui.ParagraphConstraints(width: (m['maxWidth'] as num?)?.toDouble() ?? double.infinity));
    return para;
  }

  ui.Vertices _vertices(dynamic v) {
    final m = v is Map ? v : const {};
    final positions = _offsets(m['positions']);
    final colorsRaw = m['colors'] as List?;
    return ui.Vertices(
      _vertexMode(m['mode']),
      positions,
      textureCoordinates: m['textureCoords'] is List ? _offsets(m['textureCoords']) : null,
      colors: colorsRaw?.map((c) => _decodeColor(c) ?? const Color(0xFFFFFFFF)).toList(),
      indices: m['indices'] is List ? (m['indices'] as List).map((e) => (e as num).toInt()).toList() : null,
    );
  }

  List<RSTransform> _rsTransforms(dynamic v) => v is List ? v.map<RSTransform>((t) => t is List && t.length >= 4 ? RSTransform(_d(t[0]), _d(t[1]), _d(t[2]), _d(t[3])) : RSTransform(1, 0, 0, 0)).toList() : const [];
  List<Rect> _rects(dynamic v) => v is List ? v.map<Rect>((r) => _rect(r)).toList() : const [];
  List<Color>? _colors(dynamic v) => v is List ? v.map<Color>((c) => _decodeColor(c) ?? const Color(0xFFFFFFFF)).toList() : null;

  ui.Image? _image(dynamic src) {
    final key = '$src';
    final cached = _imageCache[key];
    if (cached != null) return cached;
    if (!_imageLoading.contains(key)) {
      _imageLoading.add(key);
      _loadImage(key);
    }
    return null;
  }

  Future<void> _loadImage(String src) async {
    try {
      Uint8List bytes;
      if (src.startsWith('data:')) {
        bytes = base64Decode(src.substring(src.indexOf(',') + 1));
      } else if (src.startsWith('http')) {
        // Network images need an HTTP fetch; left to a host-provided cache.
        return;
      } else {
        final data = await rootBundle.load(src);
        bytes = data.buffer.asUint8List();
      }
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      _imageCache[src] = frame.image;
      _canvasRepaint.value++; // trigger a repaint now that the image is ready
    } catch (_) {
      // leave uncached; the op is skipped
    }
  }

  StrokeCap _strokeCap(dynamic v) => v == 'round' ? StrokeCap.round : v == 'square' ? StrokeCap.square : StrokeCap.butt;
  StrokeJoin _strokeJoin(dynamic v) => v == 'round' ? StrokeJoin.round : v == 'bevel' ? StrokeJoin.bevel : StrokeJoin.miter;
  BlurStyle _blurStyle(dynamic v) => v == 'solid' ? BlurStyle.solid : v == 'outer' ? BlurStyle.outer : v == 'inner' ? BlurStyle.inner : BlurStyle.normal;
  ui.PointMode _pointMode(dynamic v) => v == 'lines' ? ui.PointMode.lines : v == 'polygon' ? ui.PointMode.polygon : ui.PointMode.points;
  ui.VertexMode _vertexMode(dynamic v) => v == 'triangleStrip' ? ui.VertexMode.triangleStrip : v == 'triangleFan' ? ui.VertexMode.triangleFan : ui.VertexMode.triangles;
  TileMode _tileMode(dynamic v) => v == 'repeated' ? TileMode.repeated : v == 'mirror' ? TileMode.mirror : v == 'decal' ? TileMode.decal : TileMode.clamp;
  BlendMode _blend(dynamic v) => _blendTable[v] ?? BlendMode.srcOver;
}

const Map<String, BlendMode> _blendTable = {
  'clear': BlendMode.clear, 'src': BlendMode.src, 'dst': BlendMode.dst, 'srcOver': BlendMode.srcOver,
  'dstOver': BlendMode.dstOver, 'srcIn': BlendMode.srcIn, 'dstIn': BlendMode.dstIn, 'srcOut': BlendMode.srcOut,
  'dstOut': BlendMode.dstOut, 'srcATop': BlendMode.srcATop, 'dstATop': BlendMode.dstATop, 'xor': BlendMode.xor,
  'plus': BlendMode.plus, 'modulate': BlendMode.modulate, 'screen': BlendMode.screen, 'overlay': BlendMode.overlay,
  'darken': BlendMode.darken, 'lighten': BlendMode.lighten, 'colorDodge': BlendMode.colorDodge, 'colorBurn': BlendMode.colorBurn,
  'hardLight': BlendMode.hardLight, 'softLight': BlendMode.softLight, 'difference': BlendMode.difference, 'exclusion': BlendMode.exclusion,
  'multiply': BlendMode.multiply, 'hue': BlendMode.hue, 'saturation': BlendMode.saturation, 'color': BlendMode.color, 'luminosity': BlendMode.luminosity,
};

// =============================================================================
// Free enum / value tables.
// =============================================================================

Color? _decodeColor(dynamic v) {
  if (v is List && v.length >= 3) {
    return Color.fromRGBO(((v[0] as num) * 255).round(), ((v[1] as num) * 255).round(), ((v[2] as num) * 255).round(), v.length > 3 ? (v[3] as num).toDouble() : 1.0);
  }
  if (v is int) return Color(v);
  return null;
}

Gradient? _gradient(dynamic v) {
  if (v is! Map) return null;
  final colors = (v['colors'] as List? ?? const []).map((c) => _decodeColor(c) ?? Colors.transparent).toList();
  if (colors.length < 2) return null;
  return LinearGradient(colors: colors);
}

FontWeight? _weight(String? v) {
  switch (v) {
    case 'thin': return FontWeight.w100;
    case 'light': return FontWeight.w300;
    case 'normal': return FontWeight.w400;
    case 'medium': return FontWeight.w500;
    case 'semibold': return FontWeight.w600;
    case 'bold': return FontWeight.w700;
    case 'black': return FontWeight.w900;
    default: return null;
  }
}

MainAxisAlignment _mainAxis(String? v) {
  switch (v) {
    case 'center': return MainAxisAlignment.center;
    case 'end': return MainAxisAlignment.end;
    case 'between': return MainAxisAlignment.spaceBetween;
    case 'around': return MainAxisAlignment.spaceAround;
    case 'evenly': return MainAxisAlignment.spaceEvenly;
    default: return MainAxisAlignment.start;
  }
}

CrossAxisAlignment _crossAxis(String? v) {
  switch (v) {
    case 'start': return CrossAxisAlignment.start;
    case 'end': return CrossAxisAlignment.end;
    case 'stretch': return CrossAxisAlignment.stretch;
    case 'baseline': return CrossAxisAlignment.baseline;
    default: return CrossAxisAlignment.center;
  }
}

MainAxisSize _mainSize(String? v) => v == 'min' ? MainAxisSize.min : MainAxisSize.max;
Axis _axis(String? v) => v == 'horizontal' ? Axis.horizontal : v == 'vertical' ? Axis.vertical : Axis.vertical;
WrapAlignment _wrapAlign(String? v) {
  switch (v) {
    case 'center': return WrapAlignment.center;
    case 'end': return WrapAlignment.end;
    case 'between': return WrapAlignment.spaceBetween;
    case 'around': return WrapAlignment.spaceAround;
    default: return WrapAlignment.start;
  }
}
StackFit _stackFit(String? v) => v == 'expand' ? StackFit.expand : v == 'passthrough' ? StackFit.passthrough : StackFit.loose;
TextAlign _textAlign(String? v) {
  switch (v) {
    case 'center': return TextAlign.center;
    case 'right': return TextAlign.right;
    case 'left': return TextAlign.left;
    case 'justify': return TextAlign.justify;
    default: return TextAlign.start;
  }
}
TextOverflow? _overflow(String? v) {
  switch (v) {
    case 'ellipsis': return TextOverflow.ellipsis;
    case 'fade': return TextOverflow.fade;
    case 'clip': return TextOverflow.clip;
    default: return null;
  }
}
BoxFit? _boxFit(String? v) {
  switch (v) {
    case 'cover': return BoxFit.cover;
    case 'contain': return BoxFit.contain;
    case 'fill': return BoxFit.fill;
    case 'fitWidth': return BoxFit.fitWidth;
    case 'fitHeight': return BoxFit.fitHeight;
    case 'none': return BoxFit.none;
    case 'scaleDown': return BoxFit.scaleDown;
    default: return null;
  }
}
Curve _curve(String? v) {
  switch (v) {
    case 'linear': return Curves.linear;
    case 'ease': return Curves.ease;
    case 'easeIn': return Curves.easeIn;
    case 'easeOut': return Curves.easeOut;
    case 'easeInOut': return Curves.easeInOut;
    case 'bounceOut': return Curves.bounceOut;
    case 'elasticOut': return Curves.elasticOut;
    default: return Curves.easeInOut;
  }
}
TextInputType _keyboardType(String? v) {
  switch (v) {
    case 'number': return TextInputType.number;
    case 'email': return TextInputType.emailAddress;
    case 'phone': return TextInputType.phone;
    case 'url': return TextInputType.url;
    case 'multiline': return TextInputType.multiline;
    default: return TextInputType.text;
  }
}
FloatingActionButtonLocation? _fabLoc(String? v) {
  switch (v) {
    case 'centerFloat': return FloatingActionButtonLocation.centerFloat;
    case 'endTop': return FloatingActionButtonLocation.endTop;
    case 'centerDocked': return FloatingActionButtonLocation.centerDocked;
    default: return null;
  }
}

const Map<String, Alignment> _alignTable = {
  'center': Alignment.center,
  'topLeft': Alignment.topLeft,
  'topCenter': Alignment.topCenter,
  'topRight': Alignment.topRight,
  'centerLeft': Alignment.centerLeft,
  'centerRight': Alignment.centerRight,
  'bottomLeft': Alignment.bottomLeft,
  'bottomCenter': Alignment.bottomCenter,
  'bottomRight': Alignment.bottomRight,
};

// A representative Material icon table. Material icons are tree-shaken, so they
// must be referenced by const IconData — the generator (tool/gen_registry.dart)
// emits the full ~2000-entry table; this hand-written subset covers common use.
const Map<String, IconData> _iconTable = {
  'home': Icons.home, 'search': Icons.search, 'settings': Icons.settings, 'add': Icons.add,
  'remove': Icons.remove, 'close': Icons.close, 'check': Icons.check, 'menu': Icons.menu,
  'favorite': Icons.favorite, 'star': Icons.star, 'person': Icons.person, 'delete': Icons.delete,
  'edit': Icons.edit, 'share': Icons.share, 'more_vert': Icons.more_vert, 'arrow_back': Icons.arrow_back,
  'arrow_forward': Icons.arrow_forward, 'refresh': Icons.refresh, 'info': Icons.info, 'warning': Icons.warning,
  'notifications': Icons.notifications, 'shopping_cart': Icons.shopping_cart, 'play_arrow': Icons.play_arrow,
  'pause': Icons.pause, 'stop': Icons.stop, 'volume_up': Icons.volume_up, 'camera': Icons.camera_alt,
  'email': Icons.email, 'phone': Icons.phone, 'location': Icons.location_on, 'calendar': Icons.calendar_today,
};
