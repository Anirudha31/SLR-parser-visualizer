import React, { useState, useEffect } from 'react';
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
  FastForward,
  Layers,
  GitCommit,
  FileText,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  BookOpen
} from 'lucide-react';

const DEFAULT_GRAMMAR_TEXT = `E -> E + T | T
T -> T * F | F
F -> ( E ) | id`;

// Tokenizer
function tokenize(inputStr) {
  const regex = /\s*(id|[0-9]+|[+\-*\/()])/g;
  let match;
  const tokens = [];
  while ((match = regex.exec(inputStr)) !== null) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens.length > 0 ? tokens : inputStr.trim().split(/\s+/);
}

// FULLY DYNAMIC SLR(1) ENGINE
class DynamicSLRParserEngine {
  constructor(grammarText) {
    this.grammarText = grammarText;
    this.error = null;
    try {
      this.parseGrammar();
      this.computeFirstAndFollow();
      this.buildLR0States();
      this.buildParsingTable();
    } catch (err) {
      this.error = err.message;
    }
  }

  parseGrammar() {
    this.rawProductions = [];
    this.nonTerminals = new Set();
    this.terminals = new Set();

    const lines = this.grammarText.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('->');
      if (parts.length !== 2) continue;

      const lhs = parts[0].trim();
      this.nonTerminals.add(lhs);

      const rhsAlternatives = parts[1].split('|');
      for (let alt of rhsAlternatives) {
        const symbols = alt.trim().split(/\s+/).filter(Boolean);
        this.rawProductions.push({ lhs, rhs: symbols.length === 0 ? ['ε'] : symbols });
      }
    }

    if (this.rawProductions.length === 0) {
      throw new Error("No valid production rules found.");
    }

    // Augmented grammar
    const startSymbol = this.rawProductions[0].lhs;
    this.productions = [{ lhs: startSymbol + "'", rhs: [startSymbol] }];
    this.rawProductions.forEach(p => this.productions.push(p));

    // Collect terminals and non-terminals
    this.nonTerminals.add(startSymbol + "'");
    this.productions.forEach(p => {
      p.rhs.forEach(s => {
        if (s !== 'ε' && !this.nonTerminals.has(s)) {
          this.terminals.add(s);
        }
      });
    });
    this.terminals.add('$');
  }

  computeFirstAndFollow() {
    this.first = {};
    this.follow = {};

    this.nonTerminals.forEach(nt => {
      this.first[nt] = new Set();
      this.follow[nt] = new Set();
    });
    this.terminals.forEach(t => {
      this.first[t] = new Set([t]);
    });

    // Compute FIRST
    let changed = true;
    while (changed) {
      changed = false;
      this.productions.forEach(p => {
        const lhs = p.lhs;
        const rhs = p.rhs;
        let allNullable = true;

        for (let i = 0; i < rhs.length; i++) {
          const sym = rhs[i];
          const symFirst = this.first[sym] || new Set();
          let beforeSize = this.first[lhs].size;

          symFirst.forEach(s => {
            if (s !== 'ε') this.first[lhs].add(s);
          });

          if (this.first[lhs].size > beforeSize) changed = true;

          if (!symFirst.has('ε')) {
            allNullable = false;
            break;
          }
        }

        if (allNullable && rhs.length > 0) {
          if (!this.first[lhs].has('ε')) {
            this.first[lhs].add('ε');
            changed = true;
          }
        }
      });
    }

    // Compute FOLLOW
    const startSym = this.productions[0].lhs;
    this.follow[startSym].add('$');

    changed = true;
    while (changed) {
      changed = false;
      this.productions.forEach(p => {
        const lhs = p.lhs;
        const rhs = p.rhs;

        for (let i = 0; i < rhs.length; i++) {
          const b = rhs[i];
          if (!this.nonTerminals.has(b)) continue;

          let beforeSize = this.follow[b].size;

          // Find FIRST(beta) where beta is rhs[i+1 ... end]
          let allBetaNullable = true;
          for (let j = i + 1; j < rhs.length; j++) {
            const sym = rhs[j];
            const symFirst = this.first[sym] || new Set();
            symFirst.forEach(s => {
              if (s !== 'ε') this.follow[b].add(s);
            });
            if (!symFirst.has('ε')) {
              allBetaNullable = false;
              break;
            }
          }

          if (allBetaNullable || i === rhs.length - 1) {
            // Add FOLLOW(lhs) to FOLLOW(b)
            this.follow[lhs].forEach(s => this.follow[b].add(s));
          }

          if (this.follow[b].size > beforeSize) changed = true;
        }
      });
    }
  }

  itemKey(item) {
    return `${item.prodIndex}.${item.dot}`;
  }

  closure(items) {
    const closureSet = new Map();
    const queue = [...items];

    queue.forEach(item => {
      closureSet.set(this.itemKey(item), item);
    });

    let added = true;
    while (added) {
      added = false;
      const currentItems = Array.from(closureSet.values());

      currentItems.forEach(item => {
        const prod = this.productions[item.prodIndex];
        if (item.dot < prod.rhs.length) {
          const nextSymbol = prod.rhs[item.dot];
          if (this.nonTerminals.has(nextSymbol)) {
            // Add productions for nextSymbol
            this.productions.forEach((p, idx) => {
              if (p.lhs === nextSymbol) {
                const newItem = { prodIndex: idx, dot: 0 };
                const key = this.itemKey(newItem);
                if (!closureSet.has(key)) {
                  closureSet.set(key, newItem);
                  added = true;
                }
              }
            });
          }
        }
      });
    }

    return Array.from(closureSet.values()).sort((a, b) => a.prodIndex - b.prodIndex || a.dot - b.dot);
  }

  gotoSet(items, symbol) {
    const advanced = [];
    items.forEach(item => {
      const prod = this.productions[item.prodIndex];
      if (item.dot < prod.rhs.length && prod.rhs[item.dot] === symbol) {
        advanced.push({ prodIndex: item.prodIndex, dot: item.dot + 1 });
      }
    });
    return this.closure(advanced);
  }

  buildLR0States() {
    const initialItems = this.closure([{ prodIndex: 0, dot: 0 }]);
    this.states = [initialItems];
    const marked = [false];

    const symbols = Array.from(new Set([...this.nonTerminals, ...this.terminals]));

    let queue = [0];
    while (queue.length > 0) {
      const u = queue.shift();
      const currentItems = this.states[u];

      symbols.forEach(sym => {
        const nextItems = this.gotoSet(currentItems, sym);
        if (nextItems.length > 0) {
          // Check if state exists
          let existingIndex = -1;
          for (let i = 0; i < this.states.length; i++) {
            const state = this.states[i];
            if (state.length === nextItems.length) {
              let match = true;
              for (let j = 0; j < state.length; j++) {
                if (state[j].prodIndex !== nextItems[j].prodIndex || state[j].dot !== nextItems[j].dot) {
                  match = false;
                  break;
                }
              }
              if (match) {
                existingIndex = i;
                break;
              }
            }
          }

          if (existingIndex === -1) {
            existingIndex = this.states.length;
            this.states.push(nextItems);
            queue.push(existingIndex);
          }
        }
      });
    }
  }

  buildParsingTable() {
    this.actionTable = {};
    this.gotoTable = {};
    const symbols = Array.from(new Set([...this.nonTerminals, ...this.terminals]));

    for (let i = 0; i < this.states.length; i++) {
      this.actionTable[i] = {};
      this.gotoTable[i] = {};

      const items = this.states[i];
      items.forEach(item => {
        const prod = this.productions[item.prodIndex];
        if (item.dot < prod.rhs.length) {
          const nextSym = prod.rhs[item.dot];
          if (this.terminals.has(nextSym)) {
            // Shift
            const nextStateItems = this.gotoSet(items, nextSym);
            const targetState = this.findStateIndex(nextStateItems);
            if (targetState !== -1) {
              if (this.actionTable[i][nextSym] && this.actionTable[i][nextSym] !== `s${targetState}`) {
                throw new Error(`Shift-Reduce conflict at state ${i} for symbol ${nextSym}`);
              }
              this.actionTable[i][nextSym] = { type: 's', val: targetState };
            }
          }
        } else {
          // Reduce or Accept
          if (item.prodIndex === 0) {
            this.actionTable[i]['$'] = { type: 'acc' };
          } else {
            const lhs = prod.lhs;
            const followSet = this.follow[lhs] || new Set();
            followSet.forEach(term => {
              if (this.actionTable[i][term]) {
                throw new Error(`Conflict at state ${i} for term ${term}`);
              }
              this.actionTable[i][term] = { type: 'r', val: item.prodIndex };
            });
          }
        }
      });

      // GOTO table
      this.nonTerminals.forEach(nt => {
        const nextStateItems = this.gotoSet(items, nt);
        if (nextStateItems.length > 0) {
          const targetState = this.findStateIndex(nextStateItems);
          if (targetState !== -1) {
            this.gotoTable[i][nt] = targetState;
          }
        }
      });
    }
  }

  findStateIndex(items) {
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i];
      if (state.length === items.length) {
        let match = true;
        for (let j = 0; j < state.length; j++) {
          if (state[j].prodIndex !== items[j].prodIndex || state[j].dot !== items[j].dot) {
            match = false;
            break;
          }
        }
        if (match) return i;
      }
    }
    return -1;
  }

  simulate(inputString) {
    if (this.error) {
      return [{ stepNum: 0, action: 'ERROR', description: this.error, stack: [], remainingInput: [], treeRoot: null }];
    }

    const tokens = [...tokenize(inputString), '$'];
    const steps = [];
    let stack = [{ state: 0, symbol: '$', treeNode: null }];
    let remainingInput = [...tokens];

    let nodeIdCounter = 1;
    const createNode = (label, children = []) => ({
      id: `node_${nodeIdCounter++}`,
      label,
      children
    });

    steps.push({
      stepNum: 0,
      action: 'Initial State',
      stack: JSON.parse(JSON.stringify(stack)),
      remainingInput: [...remainingInput],
      activeState: 0,
      activeSymbol: tokens[0],
      treeRoot: null,
      description: 'Parser initialized with start state 0 and input string.'
    });

    let stepCount = 1;
    while (true) {
      const currentState = stack[stack.length - 1].state;
      const currentToken = remainingInput[0];

      const action = this.actionTable[currentState]?.[currentToken];

      if (!action) {
        steps.push({
          stepNum: stepCount,
          action: 'ERROR',
          stack: JSON.parse(JSON.stringify(stack)),
          remainingInput: [...remainingInput],
          activeState: currentState,
          activeSymbol: currentToken,
          treeRoot: stack.length > 1 ? stack[stack.length - 1].treeNode : null,
          description: `Syntax Error: Unexpected token '${currentToken}' in state ${currentState}.`
        });
        break;
      }

      if (action.type === 's') {
        const nextState = action.val;
        const leafNode = createNode(currentToken);
        stack.push({ state: nextState, symbol: currentToken, treeNode: leafNode });
        remainingInput.shift();

        steps.push({
          stepNum: stepCount++,
          action: `SHIFT '${currentToken}' -> State ${nextState}`,
          stack: JSON.parse(JSON.stringify(stack)),
          remainingInput: [...remainingInput],
          activeState: nextState,
          activeSymbol: currentToken,
          treeRoot: stack.length > 1 ? stack[stack.length - 1].treeNode : null,
          description: `Shifted terminal '${currentToken}' onto stack and transitioned to state ${nextState}.`
        });
      } else if (action.type === 'r') {
        const prodIndex = action.val;
        const prod = this.productions[prodIndex];
        const rhsLen = prod.rhs.length === 1 && prod.rhs[0] === 'ε' ? 0 : prod.rhs.length;

        const poppedNodes = [];
        for (let i = 0; i < rhsLen; i++) {
          const popped = stack.pop();
          poppedNodes.unshift(popped.treeNode);
        }

        const parentNode = createNode(prod.lhs, poppedNodes);
        const topState = stack[stack.length - 1].state;
        const nextState = this.gotoTable[topState]?.[prod.lhs];

        if (nextState === undefined) {
          steps.push({
            stepNum: stepCount++,
            action: 'ERROR',
            stack: JSON.parse(JSON.stringify(stack)),
            remainingInput: [...remainingInput],
            activeState: topState,
            activeSymbol: prod.lhs,
            treeRoot: parentNode,
            description: `GOTO error: No transition from state ${topState} on non-terminal ${prod.lhs}.`
          });
          break;
        }

        stack.push({ state: nextState, symbol: prod.lhs, treeNode: parentNode });

        steps.push({
          stepNum: stepCount++,
          action: `REDUCE by ${prod.lhs} -> ${prod.rhs.join(' ')}`,
          stack: JSON.parse(JSON.stringify(stack)),
          remainingInput: [...remainingInput],
          activeState: nextState,
          activeSymbol: prod.lhs,
          treeRoot: parentNode,
          description: `Reduced using (${prod.lhs} -> ${prod.rhs.join(' ')}). GOTO(${topState}, ${prod.lhs}) = ${nextState}.`
        });
      } else if (action.type === 'acc') {
        steps.push({
          stepNum: stepCount++,
          action: 'ACCEPT',
          stack: JSON.parse(JSON.stringify(stack)),
          remainingInput: [...remainingInput],
          activeState: currentState,
          activeSymbol: '$',
          treeRoot: stack[stack.length - 1].treeNode,
          description: 'Parsing successfully completed! String accepted by SLR(1) parser.'
        });
        break;
      }
    }

    return steps;
  }
}

// --- MAIN APP COMPONENT ---
export default function App() {
  const [grammarText, setGrammarText] = useState(DEFAULT_GRAMMAR_TEXT);
  const [inputString, setInputString] = useState('id + id * id');
  const [parserEngine, setParserEngine] = useState(null);
  const [steps, setSteps] = useState([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1000);
  const [activeTab, setActiveTab] = useState('visualizer');

  useEffect(() => {
    try {
      const engine = new DynamicSLRParserEngine(grammarText);
      setParserEngine(engine);
      if (!engine.error) {
        const generatedSteps = engine.simulate(inputString);
        setSteps(generatedSteps);
      } else {
        setSteps([]);
      }
      setCurrentStepIndex(0);
      setIsPlaying(false);
    } catch (err) {
      console.error(err);
      setParserEngine({ error: err.message });
      setSteps([]);
    }
  }, [grammarText, inputString]);

  useEffect(() => {
    let timer;
    if (isPlaying) {
      timer = setInterval(() => {
        setCurrentStepIndex((prev) => {
          if (prev < steps.length - 1) {
            return prev + 1;
          } else {
            setIsPlaying(false);
            return prev;
          }
        });
      }, speed);
    }
    return () => clearInterval(timer);
  }, [isPlaying, steps.length, speed]);

  const currentStep = steps[currentStepIndex] || {
    stack: [],
    remainingInput: [],
    action: 'Ready',
    description: parserEngine?.error ? `Grammar Error: ${parserEngine.error}` : 'Click Play or Next Step to begin parsing.',
    treeRoot: null
  };

  const renderTreeSvg = (node) => {
    if (!node)
      return (
        <div className="text-slate-500 text-sm italic">
          Parse tree will build as parsing progresses...
        </div>
      );

    const getNodeLayout = (n, x = 200, y = 30, dx = 80) => {
      let nodes = [{ id: n.id, label: n.label, x, y }];
      let links = [];
      if (n.children && n.children.length > 0) {
        let totalWidth = dx * (n.children.length - 1);
        let startX = x - totalWidth / 2;
        n.children.forEach((child, index) => {
          let childX = startX + index * dx;
          let childY = y + 60;
          links.push({ x1: x, y1: y + 20, x2: childX, y2: childY - 20 });
          const sub = getNodeLayout(child, childX, childY, Math.max(dx * 0.6, 40));
          nodes = nodes.concat(sub.nodes);
          links = links.concat(sub.links);
        });
      }
      return { nodes, links };
    };

    const { nodes, links } = getNodeLayout(node, 220, 35, 90);

    return (
      <div className="w-full h-80 overflow-auto bg-slate-900/80 rounded-xl border border-slate-800 p-2 flex items-center justify-center">
        <svg width="450" height="300" className="min-w-[400px]">
          {links.map((l, idx) => (
            <line
              key={idx}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke="#64748b"
              strokeWidth="2"
              strokeDasharray={l.y2 - l.y1 > 50 ? '4 4' : ''}
            />
          ))}
          {nodes.map((n) => (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
              <circle
                r="22"
                className="fill-indigo-600 stroke-indigo-400 stroke-2 transition-all duration-300 animate-glow"
              />
              <text
                textAnchor="middle"
                dy=".3em"
                className="fill-white font-bold text-xs select-none"
              >
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-600 p-2.5 rounded-xl shadow-lg shadow-indigo-500/30">
            <Layers className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              SLR(1) Dynamic Parse Stack & Tree Visualizer
            </h1>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex bg-slate-800/80 p-1 rounded-xl border border-slate-700">
          <button
            onClick={() => setActiveTab('visualizer')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'visualizer'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Visualizer Dashboard
          </button>
          <button
            onClick={() => setActiveTab('table')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'table'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            SLR(1) Parsing Table
          </button>
          <button
            onClick={() => setActiveTab('grammar')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'grammar'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Grammar & Config
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6">
        {parserEngine?.error && (
          <div className="bg-rose-950/80 border border-rose-800 text-rose-200 p-4 rounded-2xl flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            <div className="text-sm">
              <span className="font-bold">Grammar Error / Conflict:</span> {parserEngine.error}. Please check your production rules or check for shift-reduce conflicts.
            </div>
          </div>
        )}

        {activeTab === 'visualizer' && (
          <>
            {/* Top Control Bar: Input & Playback */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Input Configuration Card */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-indigo-400" /> Test String Input
                  </h3>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={inputString}
                      onChange={(e) => setInputString(e.target.value)}
                      className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-indigo-500 transition-colors"
                      placeholder="e.g. id + id * id"
                    />
                  </div>
                  <div className="flex gap-2 mt-2">
                    {['id + id * id', 'id * id + id', '( id + id ) * id'].map((ex) => (
                      <button
                        key={ex}
                        onClick={() => setInputString(ex)}
                        className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700 transition"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-slate-800/80 text-xs text-slate-400 flex justify-between items-center">
                  <span>Dynamic Engine Active</span>
                  <span className="text-indigo-400 font-semibold">SLR(1) Bottom-Up</span>
                </div>
              </div>

              {/* Playback Controls Card */}
              <div className="lg:col-span-2 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                      <Play className="w-4 h-4 text-cyan-400" /> Step-by-Step Player
                    </h3>
                    <span className="text-xs font-mono bg-indigo-950 text-indigo-300 px-3 py-1 rounded-full border border-indigo-800">
                      Step {currentStepIndex + 1} of {steps.length}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-slate-950 rounded-full h-2.5 mb-4 overflow-hidden border border-slate-800">
                    <div
                      className="bg-gradient-to-r from-indigo-500 to-cyan-400 h-2.5 transition-all duration-300"
                      style={{ width: `${((currentStepIndex + 1) / steps.length) * 100}%` }}
                    ></div>
                  </div>
                </div>

                {/* Buttons & Speed */}
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => {
                        setCurrentStepIndex(0);
                        setIsPlaying(false);
                      }}
                      className="p-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl border border-slate-700 text-slate-300 transition"
                      title="Reset"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCurrentStepIndex((prev) => Math.max(0, prev - 1))}
                      disabled={currentStepIndex === 0}
                      className="p-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-xl border border-slate-700 text-slate-300 transition"
                      title="Previous Step"
                    >
                      <SkipBack className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setIsPlaying(!isPlaying)}
                      className={`px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 shadow-lg transition ${
                        isPlaying
                          ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30'
                          : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30'
                      }`}
                    >
                      {isPlaying ? (
                        <>
                          <Pause className="w-4 h-4" /> Pause
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4" /> Play
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setCurrentStepIndex((prev) => Math.min(steps.length - 1, prev + 1))}
                      disabled={currentStepIndex === steps.length - 1}
                      className="p-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-xl border border-slate-700 text-slate-300 transition"
                      title="Next Step"
                    >
                      <SkipForward className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center space-x-3 text-xs text-slate-400">
                    <FastForward className="w-4 h-4 text-cyan-400" />
                    <span>Speed:</span>
                    <input
                      type="range"
                      min="200"
                      max="2000"
                      step="100"
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      className="accent-indigo-500 cursor-pointer w-28"
                    />
                    <span className="font-mono text-slate-200">{speed}ms</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Current Action Banner */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div
                  className={`p-2 rounded-xl ${
                    currentStep.action === 'ACCEPT'
                      ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                      : currentStep.action === 'ERROR'
                      ? 'bg-rose-600/20 text-rose-400 border border-rose-500/30'
                      : 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  }`}
                >
                  {currentStep.action === 'ACCEPT' ? (
                    <CheckCircle2 className="w-5 h-5" />
                  ) : currentStep.action === 'ERROR' ? (
                    <AlertTriangle className="w-5 h-5" />
                  ) : (
                    <GitCommit className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Current Parser Action
                  </div>
                  <div className="text-base font-bold text-white font-mono">{currentStep.action}</div>
                </div>
              </div>
              <div className="text-sm text-slate-300 max-w-xl text-right hidden md:block font-mono">
                {currentStep.description}
              </div>
            </div>

            {/* Dual Visualizer Grid: Stack (Left) & Parse Tree (Right) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Stack Visualizer Container */}
              <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-400" /> Parse Stack (Bottom-Up)
                  </h3>
                  <span className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700">
                    Top is at bottom &darr;
                  </span>
                </div>

                <div className="flex-1 min-h-[320px] bg-slate-950/80 rounded-xl border border-slate-800 p-4 flex flex-col justify-end overflow-y-auto gap-2">
                  {currentStep.stack &&
                    currentStep.stack.map((item, idx) => {
                      const isTop = idx === currentStep.stack.length - 1;
                      return (
                        <div
                          key={idx}
                          className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-300 ${
                            isTop
                              ? 'bg-indigo-950/80 border-indigo-500 shadow-lg shadow-indigo-500/20 scale-[1.02]'
                              : 'bg-slate-900/60 border-slate-800 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center space-x-3">
                            <span className="text-xs font-mono bg-slate-800 px-2 py-1 rounded text-slate-400">
                              State {item.state}
                            </span>
                            <span
                              className={`font-mono font-bold text-base ${
                                isTop ? 'text-indigo-300' : 'text-slate-300'
                              }`}
                            >
                              {item.symbol}
                            </span>
                          </div>
                          {isTop && (
                            <span className="text-[10px] bg-indigo-600 text-white px-2 py-0.5 rounded-full font-bold uppercase tracking-wider animate-pulse">
                              Top
                            </span>
                          )}
                        </div>
                      );
                    })}
                </div>

                {/* Input Stream Box */}
                <div className="mt-4 pt-4 border-t border-slate-800">
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                    Remaining Input Buffer
                  </div>
                  <div className="flex gap-1.5 overflow-x-auto py-1">
                    {currentStep.remainingInput &&
                      currentStep.remainingInput.map((token, idx) => (
                        <span
                          key={idx}
                          className={`font-mono text-xs px-3 py-1.5 rounded-lg border ${
                            idx === 0
                              ? 'bg-cyan-950 border-cyan-500 text-cyan-300 font-bold shadow-md shadow-cyan-500/20'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          {token}
                        </span>
                      ))}
                  </div>
                </div>
              </div>

              {/* Parse Tree Visualizer Container */}
              <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                    <GitCommit className="w-4 h-4 text-cyan-400" /> Dynamic Parse Tree Builder
                  </h3>
                  <span className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700">
                    Bottom-Up Construction
                  </span>
                </div>

                <div className="flex-1 flex items-center justify-center">
                  {renderTreeSvg(currentStep.treeRoot)}
                </div>

                <div className="mt-4 pt-4 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400">
                  <span>Grammar Production Rules applied bottom-up</span>
                  <span className="text-emerald-400 font-semibold">Active Node Hierarchy</span>
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === 'table' && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <h3 className="text-lg font-bold text-white mb-2">Dynamically Computed SLR(1) Parsing Table</h3>
            <p className="text-xs text-slate-400 mb-6">
              Generated automatically from your custom context-free grammar and FOLLOW sets.
            </p>

            {parserEngine && !parserEngine.error ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="bg-slate-950 text-slate-400 border-b border-slate-800">
                      <th className="p-3 border-r border-slate-800 text-center">State</th>
                      <th className="p-3 border-r border-slate-800 text-center" colSpan={parserEngine.terminals.size}>
                        ACTION
                      </th>
                      <th className="p-3 text-center" colSpan={parserEngine.nonTerminals.size - 1}>
                        GOTO
                      </th>
                    </tr>
                    <tr className="bg-slate-950/60 text-slate-500 border-b border-slate-800">
                      <th className="p-2 border-r border-slate-800"></th>
                      {Array.from(parserEngine.terminals).map(t => (
                        <th key={t} className="p-2 border-r border-slate-800 text-center">{t}</th>
                      ))}
                      {Array.from(parserEngine.nonTerminals)
                        .filter(nt => nt !== parserEngine.productions[0].lhs)
                        .map(nt => (
                          <th key={nt} className="p-2 border-r border-slate-800 text-center">{nt}</th>
                        ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {Object.keys(parserEngine.actionTable).map(stateStr => {
                      const stateNum = Number(stateStr);
                      const actRow = parserEngine.actionTable[stateNum] || {};
                      const gotoRow = parserEngine.gotoTable[stateNum] || {};
                      const nonTermList = Array.from(parserEngine.nonTerminals).filter(nt => nt !== parserEngine.productions[0].lhs);

                      return (
                        <tr key={stateNum} className="hover:bg-slate-800/40 transition">
                          <td className="p-3 border-r border-slate-800 text-center font-bold text-indigo-400 bg-slate-950/40">
                            {stateNum}
                          </td>
                          {Array.from(parserEngine.terminals).map(term => {
                            const entry = actRow[term];
                            let cellVal = '';
                            if (entry) {
                              if (entry.type === 's') cellVal = `s${entry.val}`;
                              else if (entry.type === 'r') cellVal = `r${entry.val}`;
                              else if (entry.type === 'acc') cellVal = 'acc';
                            }
                            const isActive = currentStep && currentStep.activeState === stateNum && currentStep.activeSymbol === term;
                            return (
                              <td
                                key={term}
                                className={`p-3 border-r border-slate-800 text-center ${
                                  isActive
                                    ? 'bg-indigo-600/30 text-indigo-300 font-bold border-2 border-indigo-500'
                                    : ''
                                }`}
                              >
                                {cellVal}
                              </td>
                            );
                          })}
                          {nonTermList.map(nt => {
                            const gVal = gotoRow[nt];
                            return (
                              <td key={nt} className="p-3 border-r border-slate-800 text-center text-cyan-400 font-bold">
                                {gVal !== undefined ? gVal : ''}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-rose-400 text-sm">Please provide a valid grammar without conflicts to view the parsing table.</div>
            )}
          </div>
        )}

        {activeTab === 'grammar' && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl max-w-3xl mx-auto w-full">
            <h3 className="text-lg font-bold text-white mb-2">
              Context-Free Grammar (CFG) Configuration
            </h3>
            <p className="text-xs text-slate-400 mb-6">
              Define your grammar productions below. Use `-&gt;` for derivations and `|` for alternative right-hand sides. Changing this will dynamically recompute LR(0) states and tables!
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                  Grammar Rules
                </label>
                <textarea
                  rows={6}
                  value={grammarText}
                  onChange={(e) => setGrammarText(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl p-4 text-sm font-mono text-white focus:outline-none focus:border-indigo-500 transition"
                />
              </div>

              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl">
                <h4 className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <HelpCircle className="w-4 h-4" /> Dynamic Engine Details
                </h4>
                <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
                  <li>Computes FIRST and FOLLOW sets automatically on the fly.</li>
                  <li>Generates canonical $LR(0)$ item sets and DFA state transitions.</li>
                  <li>Builds Action & Goto tables dynamically for custom grammars.</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
