import { app } from "../../scripts/app.js";

const SET = "SetAny";
const GET = "GetAny";
const DATALIST_ID = "getsetany-keys-datalist";
const MODE_NEVER = 2;
const MODE_BYPASS = 4;
const POLL_MS = 500;

/* ------------------------------------------------------------------ */
/* 그래프 유틸                                                          */
/* ------------------------------------------------------------------ */

const rootGraph = () => app.rootGraph ?? app.graph;
const nodesOf = (g) => g?._nodes ?? g?.nodes ?? [];
const clsOf = (n) => n?.comfyClass ?? n?.type;
const widgetVal = (n, name) => n?.widgets?.find((w) => w.name === name)?.value;

function allGraphs(g = rootGraph(), out = [], seen = new Set()) {
    if (!g || seen.has(g)) return out;
    seen.add(g);
    out.push(g);
    for (const n of nodesOf(g)) {
        if (n.subgraph) allGraphs(n.subgraph, out, seen);
    }
    return out;
}

/** "5:3" 같은 서브그래프 경로 ID로 그래프 노드를 찾는다. */
function findGraphNode(fullId) {
    let g = rootGraph();
    let n = null;
    for (const part of String(fullId).split(":")) {
        if (!g) return null;
        n = g.getNodeById?.(Number(part)) ?? g.getNodeById?.(part) ?? null;
        if (!n) return null;
        g = n.subgraph;
    }
    return n;
}

function collectAllKeys() {
    const keys = new Set();
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            const c = clsOf(n);
            if (c === SET || c === GET) {
                const k = String(widgetVal(n, "key") ?? "").trim();
                if (k) keys.add(k);
            }
        }
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
}

/** 우선순위 내림차순 → Y 오름차순 → X 오름차순 → ID 오름차순 */
function sortCandidates(list) {
    return list.sort(
        (a, b) =>
            b.priority - a.priority ||
            a.y - b.y ||
            a.x - b.x ||
            String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
    );
}

/* ------------------------------------------------------------------ */
/* 프롬프트 치환 (실제 실행에 영향을 주는 핵심 부분)                        */
/* ------------------------------------------------------------------ */

function scopeOf(id) {
    const parts = String(id).split(":");
    return parts.slice(0, -1).join(":");
}

function resolveInPrompt(output) {
    if (!output) return;

    const setIds = [];
    const getIds = [];
    for (const [id, node] of Object.entries(output)) {
        if (node.class_type === SET) setIds.push(id);
        else if (node.class_type === GET) getIds.push(id);
    }
    if (!getIds.length && !setIds.length) return;

    // graphToPrompt는 mute/bypass 노드를 이미 output에서 제외한다.
    // 입력이 연결되지 않은(또는 mute 된 상류에 연결된) Set도 value가 배열이 아니므로 제외된다.
    const candidatesByScopeKey = new Map();
    for (const id of setIds) {
        const inputs = output[id].inputs ?? {};
        if (!Array.isArray(inputs.value)) continue;
        const gn = findGraphNode(id);
        const key = String(gn ? widgetVal(gn, "key") : inputs.key ?? "").trim();
        if (!key) continue;
        const priority = Number(gn ? widgetVal(gn, "priority") : inputs.priority ?? 0) || 0;
        const mapKey = scopeOf(id) + "\u0000" + key;
        if (!candidatesByScopeKey.has(mapKey)) candidatesByScopeKey.set(mapKey, []);
        candidatesByScopeKey.get(mapKey).push({
            id,
            priority,
            x: gn?.pos?.[0] ?? 0,
            y: gn?.pos?.[1] ?? 0,
            ref: inputs.value,
        });
    }

    // Get 노드 → 우승 Set의 원본 참조([nodeId, slot]) 또는 null
    const getMap = new Map();
    for (const id of getIds) {
        const inputs = output[id].inputs ?? {};
        const gn = findGraphNode(id);
        const key = String(gn ? widgetVal(gn, "key") : inputs.key ?? "").trim();
        const list = key ? candidatesByScopeKey.get(scopeOf(id) + "\u0000" + key) : null;
        const winner = list?.length ? sortCandidates([...list])[0] : null;
        getMap.set(id, winner ? winner.ref : null);
    }

    const resolveRef = (ref) => {
        let guard = 0;
        while (Array.isArray(ref) && getMap.has(String(ref[0]))) {
            if (++guard > 64) return null; // 순환 참조 방지
            ref = getMap.get(String(ref[0]));
        }
        return Array.isArray(ref) ? ref : null;
    };

    for (const [id, node] of Object.entries(output)) {
        if (node.class_type === SET || node.class_type === GET) continue;
        const inputs = node.inputs;
        if (!inputs) continue;
        for (const name of Object.keys(inputs)) {
            const v = inputs[name];
            if (Array.isArray(v) && getMap.has(String(v[0]))) {
                const resolved = resolveRef(v);
                if (resolved) inputs[name] = resolved;
                else delete inputs[name]; // 소스 없음 → 백엔드가 "필수 입력 누락"으로 알려줌
            }
        }
    }

    for (const id of [...setIds, ...getIds]) delete output[id];
}

/* ------------------------------------------------------------------ */
/* 노드 제목을 key 값으로 표시                                             */
/* ------------------------------------------------------------------ */

const TITLE_SUFFIX = " (GetSetAny)";
const DEFAULT_BASE = { [SET]: "Set Any", [GET]: "Get Any" };

/** 제목이 "<무언가> (GetSetAny)" 형태일 때만 앞부분을 key로 교체한다. (직접 이름을 바꾼 노드는 건드리지 않음) */
function updateTitle(node) {
    const c = clsOf(node);
    if (c !== SET && c !== GET) return;
    if (typeof node.title !== "string" || !node.title.endsWith(TITLE_SUFFIX)) return;
    const key = String(widgetVal(node, "key") ?? "").trim();
    const next = (key || DEFAULT_BASE[c]) + TITLE_SUFFIX;
    if (node.title !== next) {
        node.title = next;
        app.canvas?.setDirty?.(true, true);
    }
}

/* ------------------------------------------------------------------ */
/* 키 입력 위젯 (자동완성)                                                */
/* ------------------------------------------------------------------ */

function refreshDatalist() {
    let dl = document.getElementById(DATALIST_ID);
    if (!dl) {
        dl = document.createElement("datalist");
        dl.id = DATALIST_ID;
        document.body.appendChild(dl);
    }
    const opts = collectAllKeys().map((k) => {
        const o = document.createElement("option");
        o.value = k;
        return o;
    });
    dl.replaceChildren(...opts);
}

function setupKeyWidget(node) {
    try {
        const idx = node.widgets?.findIndex((w) => w.name === "key") ?? -1;
        if (idx < 0) return;
        const old = node.widgets[idx];

        const el = document.createElement("input");
        el.type = "text";
        el.placeholder = "key";
        el.value = old.value ?? "";
        el.setAttribute("list", DATALIST_ID);
        el.setAttribute("autocomplete", "off");
        Object.assign(el.style, {
            width: "100%",
            boxSizing: "border-box",
            padding: "2px 6px",
            fontSize: "12px",
        });
        el.addEventListener("focus", refreshDatalist);
        el.addEventListener("input", () => {
            updateTitle(node);
            refreshDatalist();
            rootGraph()?.change?.();
            app.canvas?.setDirty?.(true, true);
        });
        el.addEventListener("keydown", (e) => e.stopPropagation());

        const w = node.addDOMWidget("key", "text", el, {
            getValue: () => el.value,
            setValue: (v) => {
                el.value = v ?? "";
                updateTitle(node);
            },
            getMinHeight: () => 26,
        });

        // 기존 캔버스 위젯 제거 후 원래 위치(첫 번째)로 이동해 widgets_values 순서를 유지
        node.widgets.splice(node.widgets.indexOf(old), 1);
        node.widgets.splice(node.widgets.indexOf(w), 1);
        node.widgets.splice(Math.min(idx, node.widgets.length), 0, w);
        node.setSize?.(node.computeSize());
    } catch (e) {
        console.warn("[GetSetAny] key 자동완성 위젯 생성 실패, 기본 위젯 사용:", e);
    }
}

/* ------------------------------------------------------------------ */
/* 실시간 상태 표시 (GetAny 아래에 현재 연결된 Set 표시)                    */
/* ------------------------------------------------------------------ */

function linkOf(graph, id) {
    if (id == null) return null;
    if (graph.getLink) return graph.getLink(id);
    return graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id];
}

function graphCandidates(graph, key) {
    const list = [];
    for (const n of nodesOf(graph)) {
        if (clsOf(n) !== SET) continue;
        if (n.mode === MODE_NEVER || n.mode === MODE_BYPASS) continue;
        if (String(widgetVal(n, "key") ?? "").trim() !== key) continue;
        if (n.inputs?.[0]?.link == null) continue;
        list.push({
            id: n.id,
            node: n,
            priority: Number(widgetVal(n, "priority")) || 0,
            x: n.pos?.[0] ?? 0,
            y: n.pos?.[1] ?? 0,
        });
    }
    return sortCandidates(list);
}

function refreshStatuses() {
    const graph = app.canvas?.graph;
    if (!graph) return;
    let changed = false;
    for (const n of nodesOf(graph)) updateTitle(n);
    for (const n of nodesOf(graph)) {
        if (clsOf(n) !== GET) continue;
        const key = String(widgetVal(n, "key") ?? "").trim();
        let status;
        let label = "value";
        if (!key) {
            status = "key 없음";
        } else {
            const cands = graphCandidates(graph, key);
            if (!cands.length) {
                status = "⚠ 연결된 SetAny 없음";
            } else {
                const w = cands[0];
                status = `← #${w.id} (p${w.priority}) / 후보 ${cands.length}`;
                try {
                    const lk = linkOf(graph, w.node.inputs[0].link);
                    if (lk?.type && lk.type !== "*") label = String(lk.type);
                } catch (_) {}
            }
        }
        if (n._gsaStatus !== status) {
            n._gsaStatus = status;
            changed = true;
        }
        if (n.outputs?.[0] && n.outputs[0].label !== label) {
            n.outputs[0].label = label;
            changed = true;
        }
    }
    if (changed) app.canvas.setDirty(true, true);
}

/* ------------------------------------------------------------------ */
/* 확장 등록                                                            */
/* ------------------------------------------------------------------ */

app.registerExtension({
    name: "Comfy.GetSetAny",

    async setup() {
        const orig = app.graphToPrompt;
        app.graphToPrompt = async function (...args) {
            const result = await orig.apply(this, args);
            try {
                resolveInPrompt(result?.output);
            } catch (e) {
                console.error("[GetSetAny] 프롬프트 치환 중 오류:", e);
            }
            return result;
        };
        setInterval(refreshStatuses, POLL_MS);
    },

    async nodeCreated(node) {
        const c = clsOf(node);
        if (c !== SET && c !== GET) return;

        setupKeyWidget(node);
        updateTitle(node);

        if (c === GET) {
            node.onDrawForeground = function (ctx) {
                if (this.flags?.collapsed || !this._gsaStatus) return;
                ctx.save();
                ctx.font = "11px sans-serif";
                ctx.fillStyle = this._gsaStatus.startsWith("⚠") ? "#e66" : "#999";
                ctx.fillText(this._gsaStatus, 6, this.size[1] + 14);
                ctx.restore();
            };
        }

        const origConn = node.onConnectionsChange;
        node.onConnectionsChange = function (...a) {
            const r = origConn?.apply(this, a);
            setTimeout(refreshStatuses, 0);
            return r;
        };
        const origMode = node.onModeChange;
        node.onModeChange = function (...a) {
            const r = origMode?.apply(this, a);
            setTimeout(refreshStatuses, 0);
            return r;
        };
    },
});
