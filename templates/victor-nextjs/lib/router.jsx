// lib/router.jsx — a tiny Next.js-style client router for Victor.
//
// There is no server and no URL bar; navigation is in-memory state. The build
// tool scans app/**/page.jsx into a routes manifest and hands it to <VictorApp>,
// which keeps the current path in a useState and renders the matching page
// inside the app layout. `useRouter()` and `<Link>` mirror `next/navigation`.

import { useState, useMemo, createContext, useContext } from "react";

export var RouterContext = createContext(null);

// next/navigation's useRouter(): { path, push(href), back() }.
export function useRouter() {
  return useContext(RouterContext);
}

// A navigation button — the Victor analogue of next/link's <Link>.
export function Link(props) {
  var router = useRouter();
  var kind = props.active ? "tonal" : "ghost";
  return (
    <button
      kind={kind}
      onPress={function () {
        router.push(props.href);
      }}
    >
      {props.children}
    </button>
  );
}

function __victorFindRoute(routes, path) {
  for (var i = 0; i < routes.length; i++) {
    if (routes[i].path == path) {
      return routes[i].component;
    }
  }
  return routes[0].component;
}

// The application shell: router state + layout + the active page.
export function VictorApp(props) {
  var routes = props.routes;
  var Layout = props.layout;

  var s = useState(props.initial || "/");
  var path = s[0];
  var setPath = s[1];

  var router = useMemo(
    function () {
      return {
        path: path,
        push: function (to) {
          setPath(to);
        },
        back: function () {
          setPath("/");
        },
      };
    },
    [path]
  );

  var Page = __victorFindRoute(routes, path);

  return (
    <RouterContext.Provider value={router}>
      <Layout>
        <Page />
      </Layout>
    </RouterContext.Provider>
  );
}
