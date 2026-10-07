function frameRunner() {
  const send = (kind, payload) => parent.postMessage({ kind, payload }, "*");
  let port;
  let run;
  let scheduled = false;
  let renders = 0;
  let held = [];
  const heldByKey = new Map();
  const call = (kind, payload) => {
    port.stage("client", kind, payload);
    return run();
  };
  const draw = () => {
    if (scheduled || renders >= 3) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renders++;
      try {
        const tree = JSON.parse(String(call("render")));
        port.dropHeld("client", held);
        held = [];
        heldByKey.clear();
        const walk = (node) => {
          if (typeof node !== "object" || node === null) return;
          const n = node;
          if (n.held !== undefined) {
            held.push(n.held);
            if (typeof n.props?.key === "string") heldByKey.set(n.props.key, n.held);
          }
          n.children?.forEach(walk);
        };
        walk(tree);
        send("tree", tree);
      } catch (error) {
        send("error", String(error));
      }
    });
  };
  const timers = new Map();
  let nextTimer = 0;
  addEventListener("message", async (event) => {
    if (event.source !== parent) return;
    const { kind, payload } = event.data;
    renders = 0;
    try {
      if (kind === "init") {
        const bundle = payload.bundle;
        const imports = {};
        for (const file of bundle.files)
          imports[file.key] = URL.createObjectURL(
            new Blob([file.source], { type: "text/javascript" }),
          );
        const map = document.createElement("script");
        map.type = "importmap";
        map.textContent = JSON.stringify({ imports });
        document.head.append(map);
        const runtime = await import(/* @vite-ignore */ imports[bundle.runtime]);
        port = runtime.install(
          {
            schedule: draw,
            startTimer: (_id, interval) => {
              const id = ++nextTimer;
              timers.set(
                id,
                setInterval(
                  () => {
                    renders = 0;
                    call("tick", id);
                    draw();
                  },
                  Math.max(16, interval),
                ),
              );
              return id;
            },
            stopTimer: (_id, id) => {
              clearInterval(timers.get(id));
              timers.delete(id);
            },
            post: (_id, data) => send("post", JSON.parse(data)),
          },
          bundle.limits,
        );
        run = globalThis.__surface__.run;
        const entry = bundle.modules.find((module) => module.module === payload.module);
        if (!entry) throw new Error("Missing mod client module.");
        const module = await import(/* @vite-ignore */ imports[entry.entry]);
        port.mount("client", module[entry.component], payload.props);
        port.resize("client", payload.columns, payload.rows);
        draw();
      } else if (kind === "props" && port) {
        port.setProps("client", payload);
        draw();
      } else if (kind === "held" && port) {
        call("held", { ...payload, handle: heldByKey.get(payload.key) ?? payload.handle });
      } else if (kind === "resize" && port) {
        port.resize("client", payload.columns, payload.rows);
        draw();
      } else if ((kind === "key" || kind === "pointer") && port) {
        if (port.hasListener("client", kind)) call(kind, payload);
      }
    } catch (error) {
      send("error", String(error));
    }
  });
  send("ready", null);
}

frameRunner();
