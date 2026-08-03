// The mini-app programs, as source strings handed to Victor. Each is ordinary
// JavaScript (the js2elpian subset) that the Elpian VM runs in its own isolated
// instance; `RN` is the React Native widget facade from reactnative.js. Kept as
// string constants so no bundler raw-loader config is needed to embed them.

/** Mini app #1 — a counter with +/- buttons. */
export const COUNTER = String.raw`
import 'reactnative.js';

var n = 0;
var label = null;

function render() {
  label.set('text', 'Count: ' + n);
}

function main() {
  var col = RN.column({ flex: 1, bg: '#0b1220', padding: 20, gap: 12, justify: 'center', align: 'center' });
  col.add(RN.text('Counter mini app', { color: '#94a3b8', fontSize: 14 }));
  label = RN.text('Count: 0', { color: '#38bdf8', fontSize: 34, fontWeight: '700' });
  col.add(label);
  var row = RN.row({ gap: 12 });
  row.add(RN.button({ title: '-1', onPress: function (e) { n = n - 1; render(); } }));
  row.add(RN.button({ title: '+1', onPress: function (e) { n = n + 1; render(); } }));
  col.add(row);
  RN.mount(col);
  print('counter up');
}

main();
`;

/** Mini app #2 — a live greeter (text input → echoed greeting). */
export const GREETER = String.raw`
import 'reactnative.js';

var echo = null;

function greet(t) {
  if (t == null || t == '') { return 'Hello there!'; }
  return 'Hello, ' + t + '!';
}

function main() {
  var col = RN.column({ flex: 1, bg: '#111827', padding: 20, gap: 12, justify: 'center' });
  col.add(RN.text('Greeter mini app', { color: '#94a3b8', fontSize: 14 }));
  col.add(RN.input({
    placeholder: 'Your name',
    color: '#e2e8f0', fontSize: 18, bg: '#0b1220', padding: 10, radius: 8,
    onChangeText: function (t) { echo.set('text', greet(t)); },
  }));
  echo = RN.text('Hello there!', { color: '#a78bfa', fontSize: 24, fontWeight: '700' });
  col.add(echo);
  RN.mount(col);
  print('greeter up');
}

main();
`;
