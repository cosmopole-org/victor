// =============================================================================
// main.dart — the Elpian Flutter host: a declarative widget-tree interpreter.
// =============================================================================
//
// This is the FIXED Flutter app the GDExtension embeds (see ../FLUTTER.md and
// ../extension/src/flutter_view.cpp). It contains NO application logic. Its only
// job is to be a faithful renderer of widget trees the Elpian VM sends:
//
//   Elpian VM guest (dynamic, no JIT)                 this app (static, AOT)
//   ─────────────────────────────────                ──────────────────────
//   FL.mount(node, App)  ── flutter.op ─▶  C++ FlutterController
//   App() -> {t,p,c} tree ──render op──▶   FlutterView.send_widget_tree
//                                          └─ BasicMessageChannel "elpian/widgets"
//                                             → _WidgetHost rebuilds the tree
//   a widget fires (onTap) ─────────────▶  BasicMessageChannel "elpian/events"
//                                          → C++ queues {cb,args} → __godotDispatch
//                                             → the owning VM's handler runs
//
// Because the app ships as an AOT snapshot and only ever interprets *data*, the
// no-JIT / no-codegen contract holds end to end: iOS-legal, and it is the exact
// mirror of how `godot.dart`'s reflective ops drive Godot — here the ops build
// real Flutter widgets instead of Godot nodes.
//
// The `type -> widget` mapping lives ONLY here (the guest `FL` facade is a thin
// data builder), so extending the widget vocabulary is a change to this file
// alone — no engine, C++, or VM change. The registry can be grown by hand or
// generated from Flutter's own API with the analyzer; either way coverage is a
// property of this app, not of the protocol.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

// The two channels shared with the C++ FlutterView.
const _widgetsChannel = BasicMessageChannel<String>('elpian/widgets', StringCodec());
const _eventsChannel = BasicMessageChannel<String>('elpian/events', StringCodec());

void main() {
  runApp(const _ElpianHostApp());
}

class _ElpianHostApp extends StatefulWidget {
  const _ElpianHostApp();
  @override
  State<_ElpianHostApp> createState() => _ElpianHostState();
}

class _ElpianHostState extends State<_ElpianHostApp> {
  // The current serialized root tree (`{t,p,c}`), or null before the first frame.
  Map<String, dynamic>? _root;

  @override
  void initState() {
    super.initState();
    // Host → app: a new widget tree to render. The message is the JSON produced
    // by the guest's `FL` facade and reified by the C++ side.
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

  @override
  Widget build(BuildContext context) {
    final root = _root;
    if (root == null) {
      return const SizedBox.shrink();
    }
    // The guest usually sends a MaterialApp/Scaffold at the root; if not, wrap it
    // so text has a Directionality/Material context.
    final built = _buildNode(root);
    if (root['t'] == 'MaterialApp') {
      return built;
    }
    return MaterialApp(debugShowCheckedBanner: false, home: built);
  }

  // ---------------------------------------------------------------------------
  // The interpreter: one serialized node -> one real widget.
  // ---------------------------------------------------------------------------

  Widget _buildNode(dynamic node) {
    if (node == null) return const SizedBox.shrink();
    if (node is String) return Text(node);
    if (node is num || node is bool) return Text('$node');
    if (node is! Map) return const SizedBox.shrink();

    final String type = node['t'] as String? ?? '';
    final Map props = node['p'] as Map? ?? const {};
    final List children = node['c'] as List? ?? const [];

    List<Widget> kids() => children.map(_buildNode).toList();
    Widget kid() => children.isEmpty ? const SizedBox.shrink() : _buildNode(children.first);

    switch (type) {
      case 'MaterialApp':
        return MaterialApp(
          debugShowCheckedBanner: false,
          theme: props['dark'] == true ? ThemeData.dark() : ThemeData.light(),
          home: _buildNode(props['home']),
        );
      case 'Scaffold':
        return Scaffold(
          backgroundColor: _color(props['backgroundColor']),
          appBar: props['appBar'] != null ? _buildAppBar(props['appBar']) : null,
          body: _buildNode(props['body']),
          floatingActionButton:
              props['fab'] != null ? _buildNode(props['fab']) : null,
        );
      case 'AppBar':
        return _appBarBody(props);
      case 'Text':
        return Text(
          '${props['data'] ?? ''}',
          style: _textStyle(props['style']),
        );
      case 'Column':
        return Column(
          mainAxisAlignment: _mainAxis(props['main']),
          crossAxisAlignment: _crossAxis(props['cross']),
          children: kids(),
        );
      case 'Row':
        return Row(
          mainAxisAlignment: _mainAxis(props['main']),
          crossAxisAlignment: _crossAxis(props['cross']),
          children: kids(),
        );
      case 'Stack':
        return Stack(children: kids());
      case 'Center':
        return Center(child: kid());
      case 'Padding':
        return Padding(padding: _edge(props['all']), child: kid());
      case 'Container':
        return Container(
          color: _color(props['color']),
          padding: props['pad'] != null ? _edge(props['pad']) : null,
          width: _d(props['width']),
          height: _d(props['height']),
          child: children.isEmpty ? null : kid(),
        );
      case 'SizedBox':
        return SizedBox(
          width: _d(props['width']),
          height: _d(props['height']),
          child: children.isEmpty ? null : kid(),
        );
      case 'Expanded':
        return Expanded(child: kid());
      case 'ListView':
        return ListView(children: kids());
      case 'Image':
        return _image(props);
      case 'Icon':
        return Icon(_icon(props['name']), size: _d((props['opts'] as Map?)?['size']));
      case 'FilledButton':
        return FilledButton(
          onPressed: _tap(props['onTap']),
          child: Text('${props['label'] ?? ''}'),
        );
      case 'TextButton':
        return TextButton(
          onPressed: _tap(props['onTap']),
          child: Text('${props['label'] ?? ''}'),
        );
      case 'IconButton':
        return IconButton(
          onPressed: _tap(props['onTap']),
          icon: Icon(_icon(props['name'])),
        );
      case 'TextField':
        return TextField(
          decoration: InputDecoration(hintText: props['hint']?.toString()),
          onChanged: _tapArg(props['onChanged']),
          onSubmitted: _tapArg(props['onSubmitted']),
        );
      case 'Switch':
        return Switch(
          value: props['value'] == true,
          onChanged: (v) => _fireArg(props['onChanged'], v),
        );
      case 'Slider':
        return Slider(
          value: _d(props['value']) ?? 0.0,
          min: _d(props['min']) ?? 0.0,
          max: _d(props['max']) ?? 1.0,
          onChanged: (v) => _fireArg(props['onChanged'], v),
        );
      default:
        // Unknown type: render nothing rather than crash the whole surface.
        return const SizedBox.shrink();
    }
  }

  // ---- event plumbing -------------------------------------------------------

  // A `{callable: id}` tag → a zero-arg callback that posts the event back.
  VoidCallback? _tap(dynamic handler) {
    final id = _cbId(handler);
    if (id == null) return null;
    return () => _fire(id, const []);
  }

  // A `{callable: id}` tag → a one-arg callback (value forwarded as args[0]).
  ValueChanged<T>? _tapArg<T>(dynamic handler) {
    final id = _cbId(handler);
    if (id == null) return null;
    return (T v) => _fire(id, [v]);
  }

  void _fireArg(dynamic handler, dynamic value) {
    final id = _cbId(handler);
    if (id != null) _fire(id, [value]);
  }

  int? _cbId(dynamic handler) {
    if (handler is Map && handler['callable'] is int) return handler['callable'] as int;
    return null;
  }

  void _fire(int cb, List<dynamic> args) {
    _eventsChannel.send(json.encode({'cb': cb, 'args': args}));
  }

  // ---- small value decoders -------------------------------------------------

  PreferredSizeWidget _buildAppBar(dynamic node) {
    if (node is Map && node['t'] == 'AppBar') {
      return _appBarBody(node['p'] as Map? ?? const {});
    }
    return AppBar(title: _buildNode(node));
  }

  AppBar _appBarBody(Map props) => AppBar(title: _buildNode(props['title']));

  double? _d(dynamic v) => v is num ? v.toDouble() : null;

  EdgeInsets _edge(dynamic v) => EdgeInsets.all(_d(v) ?? 0.0);

  Color? _color(dynamic v) {
    // Accept an [r,g,b,a] (0..1) list or a 0xAARRGGBB int.
    if (v is List && v.length >= 3) {
      return Color.fromRGBO(
        ((v[0] as num) * 255).round(),
        ((v[1] as num) * 255).round(),
        ((v[2] as num) * 255).round(),
        v.length > 3 ? (v[3] as num).toDouble() : 1.0,
      );
    }
    if (v is int) return Color(v);
    return null;
  }

  TextStyle? _textStyle(dynamic style) {
    if (style is! Map) return null;
    return TextStyle(
      fontSize: _d(style['size']),
      fontWeight: style['bold'] == true ? FontWeight.bold : null,
      color: _color(style['color']),
    );
  }

  Widget _image(Map props) {
    final src = '${props['src'] ?? ''}';
    if (src.startsWith('http')) return Image.network(src);
    if (src.startsWith('data:')) {
      final b64 = src.substring(src.indexOf(',') + 1);
      return Image.memory(base64Decode(b64));
    }
    return Image.asset(src);
  }

  // A tiny name→IconData table (Material icons are tree-shaken, so they must be
  // referenced by constant, not looked up dynamically — hence a fixed map).
  IconData _icon(dynamic name) {
    switch ('$name') {
      case 'home':
        return Icons.home;
      case 'search':
        return Icons.search;
      case 'settings':
        return Icons.settings;
      case 'add':
        return Icons.add;
      case 'favorite':
        return Icons.favorite;
      case 'menu':
        return Icons.menu;
      case 'close':
        return Icons.close;
      case 'check':
        return Icons.check;
      default:
        return Icons.circle;
    }
  }

  MainAxisAlignment _mainAxis(dynamic v) {
    switch ('$v') {
      case 'center':
        return MainAxisAlignment.center;
      case 'end':
        return MainAxisAlignment.end;
      case 'between':
        return MainAxisAlignment.spaceBetween;
      case 'around':
        return MainAxisAlignment.spaceAround;
      case 'evenly':
        return MainAxisAlignment.spaceEvenly;
      default:
        return MainAxisAlignment.start;
    }
  }

  CrossAxisAlignment _crossAxis(dynamic v) {
    switch ('$v') {
      case 'start':
        return CrossAxisAlignment.start;
      case 'end':
        return CrossAxisAlignment.end;
      case 'stretch':
        return CrossAxisAlignment.stretch;
      default:
        return CrossAxisAlignment.center;
    }
  }
}
