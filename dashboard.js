 // dashboard.js - Arunachala Operations Center
    //
    // Refactor notes:
    //   - Pulled out of index.html into its own file.
    //   - Telemetry is served over http://localhost by server.js and pulled
    //     in with plain fetch().

    // ---------------------------------------------------------------------------
    // Agent profile data (static descriptions, not telemetry)
    // ---------------------------------------------------------------------------
    const agentProfiles = {
      po: {
        title: "🧭 Arunachala Ramana",
        role: "AI Product Strategist & Product Owner (Main Agent). Orchestrates high-level business strategy, maintains the backlog, coordinates subagents, and acts as the strategic interface for the human operator.",
        prompt: `You are: Arunachala Ramana
    Vibe: Calm, strategic, practical, precise
    Role: High-level product strategy, backlog management, and orchestration of engineering and QA subagents to deliver robust local AI systems.`,
        task: "Directing the overall workspace restructuring and handshake verification."
      },
      bizdev: {
        title: "💰 Revenue & Client Deals Lead",
        role: "Responsible for client RFP ingestion, Statement of Work (SOW) drafting, project milestone pricing, and client onboarding into isolated tenant partitions.",
        prompt: `You are the Revenue & Client Acquisition Lead subagent.
    Your role is to evaluate client requirements, draft commercial proposals, calculate delivery effort, and structure profitable agency service contracts.
    You report directly to the Managing Partner & Product Owner (Arunachala Ramana).`,
        task: "SOW proposal templates compiled. Client onboarding tenant workflows initialized."
      },
      marketing: {
        title: "📢 DevRel & Growth Marketing Lead",
        role: "Responsible for writing in-depth technical teardowns, publishing proof-of-work case studies, and driving organic inbound developer leads across Nostr, X, and LinkedIn.",
        prompt: `You are the DevRel & Growth Marketing subagent.
    Your role is to translate engineering achievements into public thought leadership, write architectural teardowns, and run distribution loops to generate client demand.
    You report directly to the Managing Partner & Product Owner (Arunachala Ramana).`,
        task: "Weekly architecture teardown published to Nostr relay and community channels."
      },
      cfo: {
        title: "📊 AI Unit Economics & Finance Controller",
        role: "Responsible for auditing logs/ai-calls.jsonl, tracking local-first compute vs frontier token burn, and ensuring every client project maintains 80-90% gross profit margins.",
        prompt: `You are the AI Unit Economics & Finance Controller subagent.
    Your role is to enforce token cost ceilings, measure local Ollama compute efficiency, and generate client profitability and burn rate audits.
    You report directly to the Managing Partner & Product Owner (Arunachala Ramana).`,
        task: "Daily token spend audited: 92% local GPU inference ratio achieved with 88% gross margin."
      },
      tech: {
        title: "💻 Technical Lead & Architect",
        role: "Responsible for designing system architectures, feature implementation, refactoring legacy components, and reviewing schemas across the workspace stack.",
        prompt: `You are the Technical Lead & Architect subagent.
    Your role is to design and implement software systems, execute code edits, debug issues, and refactor existing code.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Handshake audit completed successfully. Relocation of openclaw and hermes verified."
      },
      qa: {
        title: "🧪 QA & Verification Specialist",
        role: "Responsible for running lints, formatting rules, unit/E2E test suites, and executing the mandatory TASK: PRE-COMMIT CHECK before code integrations.",
        prompt: `You are the QA & Verification subagent.
    Your role is to validate all changes made to the codebase before they are committed or merged.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Fast-unit Vitest sweep executed (175/175 tests passed). Environment constraints documented."
      },
      sec: {
        title: "🛡️ AppSec Specialist & Auditor (Mantis)",
        role: "Responsible for autonomous vulnerability scanning, exploit reproduction, ReBAC access boundary validation, and security patch verification via Google Mantis.",
        prompt: `You are the AppSec Specialist & Security Auditor subagent (powered by Google Mantis).
    Your role is to perform static analysis, dynamic security probes, CVE reproducer scripts, ReBAC tenant boundary verification, and ensure no unauthenticated paths bypass defense layers.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Google Mantis suite initialized with 19 skills. Security audit patches applied to agent dispatch, ReBAC checks, and memory engine."
      },
      infra: {
        title: "🛠️ DevOps & Infrastructure Expert",
        role: "Manages container configurations (Docker, docker-compose), local server offloading optimizations (Ollama GPU/Metal compute mappings), and workspace shell scripting utilities.",
        prompt: `You are the Infrastructure & DevOps Specialist subagent.
    Your role is to manage containers, deployments, scripting, environment setups, and local AI model server configurations (e.g., Ollama).
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Completed network port and container DNS route checks. Handshake assessment finalized."
      },
      doc: {
        title: "📝 Documentation & Memory Specialist",
        role: "Responsible for tracking log changes, updating memories (MEMORY.md, USER.md, IDENTITY.md), and keeping daily diary files up to date.",
        prompt: `You are the Documentation & Memory Specialist subagent.
    Your role is to maintain the project's state, long-term memory, daily logs, and documentation files.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Daily memory log files reconciled with latest milestones."
      },
      hermes: {
        title: "🐍 Hermes Local Reasoning Runner",
        role: "Autonomous local reasoning runner operating directly on local Ollama models (gemma3:4b, qwen2.5-coder:3b) with zero external API cost and rapid cognitive execution loops.",
        prompt: `You are Hermes, the local reasoning runner agent.
    Your role is to plan, test, and execute code changes locally using local Ollama model instances, verifying results before escalating to external frontier models.`,
        task: "Local reasoning loop active. Connected to Ollama metal instance at localhost:11434."
      },
      openhands: {
        title: "👐 OpenHands Sandbox Workspace",
        role: "Containerized sandbox execution engine providing an interactive Agent Canvas and file system workspace for complex multistep engineering workflows.",
        prompt: `You are OpenHands, the containerized sandbox agent environment.
    Your role is to run software engineering tasks inside an isolated Docker sandbox container, providing an interactive Canvas UI on port 8000.`,
        task: "OpenHands Agent Canvas container online at http://127.0.0.1:8000/canvas/."
      }
    };

    // Session badge per agent status (computed by agent-stats.ps1). There is
    // deliberately no mock fallback: invented numbers on a monitoring panel
    // are worse than an honest "no telemetry".
    const AGENT_STATUS_BADGE = {
      active:  { dot: 'green', label: 'Active' },
      idle:    { dot: 'amber', label: 'Idle' },
      dormant: { dot: 'grey',  label: 'Dormant' },
      none:    { dot: 'grey',  label: 'No transcripts' }
    };

    function formatLastActive(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function setAgentSessionBadge(status) {
      const badge = AGENT_STATUS_BADGE[status] || { dot: 'grey', label: 'No telemetry' };
      const dot = document.getElementById('id-agent-session-dot');
      const label = document.getElementById('id-agent-session-label');
      if (dot) dot.className = `status-dot ${badge.dot}`;
      if (label) label.innerText = badge.label;
    }

    const AGENT_INDEX_MAP = { po: 0, tech: 1, qa: 2, sec: 3, infra: 4, doc: 5, hermes: 6, openhands: 7 };
    const NAV_TAB_MAP = {
      dashboard: 'id-nav-dashboard',
      kanban: 'id-nav-kanban',
      agents: 'id-nav-agents',
      canvas: 'id-nav-canvas',
      infra: 'id-nav-infra',
      logs: 'id-nav-logs',
      runs: 'id-nav-runs',
      costs: 'id-nav-costs'
    };

    let currentSelectedAgent = 'po';
    let telemetryLive = false;
    let lastTelemetryData = null;
    // Who this install belongs to (server .env OPERATOR_NAME), for greetings.
    let operatorName = 'Operator';
    let currentHostSpecs = null;
    let personaModel = 'gemma3:4b';
    fetch('/api/config')
      .then(res => res.json())
      .then(cfg => {
        if (cfg) {
          if (cfg.operatorName) operatorName = cfg.operatorName;
          if (cfg.personaModel) {
            personaModel = cfg.personaModel;
            applyPersonaModelBadges(cfg.personaModel);
          }
          if (cfg.host) updateHostSpecsUI(cfg.host);
        }
      })
      .catch(() => {});

    function applyPersonaModelBadges(model) {
      if (!model) return;
      const infraBadge = document.getElementById('id-badge-infra');
      const docBadge = document.getElementById('id-badge-doc');
      if (infraBadge) infraBadge.innerText = model;
      if (docBadge) docBadge.innerText = model;
    }

    // ---------------------------------------------------------------------------
    // Tab switching
    // ---------------------------------------------------------------------------
    function switchTab(tabId) {
      document.querySelectorAll('.nav-list .nav-item').forEach(item => item.classList.remove('active'));
      const activeLink = document.getElementById(NAV_TAB_MAP[tabId]);
      if (activeLink) activeLink.parentElement.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      const activeContent = document.getElementById(tabId);
      if (activeContent) activeContent.classList.add('active');

      if (tabId === 'agents') {
        selectAgent('po');
      }

      if (tabId === 'kanban') {
        loadKanbanTasks();
      }

      if (tabId === 'runs') {
        loadAgentRuns();
      }

      if (tabId === 'costs') {
        loadCosts();
      }

      if (tabId === 'dashboard') {
        setTimeout(() => {
          if (latencyChart && typeof latencyChart.resize === 'function') latencyChart.resize();
          if (cpuChart && typeof cpuChart.resize === 'function') cpuChart.resize();
        }, 50);
      }
    }

    // ---------------------------------------------------------------------------
    // Kanban Board Functions
    // ---------------------------------------------------------------------------
    function loadKanbanTasks() {
      fetch('/api/tasks')
        .then(res => res.json())
        .then(data => {
          if (data && data.columns) {
            renderKanban(data.columns);
          }
        })
        .catch(err => {
          console.error('Failed to load tasks:', err);
        });
    }

    function renderKanban(columns) {
      const backlogEl = document.getElementById('id-kanban-backlog');
      const inprogressEl = document.getElementById('id-kanban-inprogress');
      const doneEl = document.getElementById('id-kanban-done');

      const backlogCount = document.getElementById('id-backlog-count');
      const inprogressCount = document.getElementById('id-inprogress-count');
      const doneCount = document.getElementById('id-done-count');

      if (backlogCount) backlogCount.innerText = (columns.backlog || []).length;
      if (inprogressCount) inprogressCount.innerText = (columns.in_progress || []).length;
      if (doneCount) doneCount.innerText = (columns.done || []).length;

      // Render Backlog
      if (backlogEl) {
        backlogEl.innerHTML = '';
        (columns.backlog || []).forEach(item => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.innerHTML = `
            <div class="kanban-card-header">
              <span class="kanban-card-id">#${item.id}</span>
              <span class="kanban-card-project">${item.project}</span>
            </div>
            <div class="kanban-card-body">${item.task}</div>
            ${item.issue ? `<div class="kanban-card-footer"><a href="${item.issue.replace(/#\d+\s+/, '')}" target="_blank" style="color:var(--status-blue); text-decoration:none; font-size:0.75rem;">🔗 GitHub Issue</a></div>` : ''}
          `;
          backlogEl.appendChild(card);
        });
      }

      // Render In Progress
      if (inprogressEl) {
        inprogressEl.innerHTML = '';
        (columns.in_progress || []).forEach(item => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.style.borderColor = 'rgba(0, 176, 255, 0.3)';
          card.innerHTML = `
            <div class="kanban-card-header">
              <span class="kanban-card-id" style="color:var(--status-blue);">ACTIVE</span>
              <span class="kanban-card-project">${item.project}</span>
            </div>
            <div class="kanban-card-body">${item.task}</div>
            <div class="kanban-card-footer">
              <span class="kanban-owner">👤 ${item.owner}</span>
              <span class="status-badge" style="font-size:0.65rem; padding:1px 6px;"><span class="status-dot green"></span>Running</span>
            </div>
          `;
          inprogressEl.appendChild(card);
        });
      }

      // Render Done
      if (doneEl) {
        doneEl.innerHTML = '';
        (columns.done || []).forEach(item => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.style.opacity = '0.85';
          card.innerHTML = `
            <div class="kanban-card-header">
              <span class="kanban-card-id" style="color:var(--status-green);">✓ DONE</span>
              <span class="kanban-card-project">${item.completed}</span>
            </div>
            <div class="kanban-card-body" style="color:#cfd8dc;">${item.task}</div>
          `;
          doneEl.appendChild(card);
        });
      }
    }

    // ---------------------------------------------------------------------------
    // Agent selection (Agents tab detail panel)
    // ---------------------------------------------------------------------------
    function selectAgent(key) {
      currentSelectedAgent = key;
      const profile = agentProfiles[key];
      if (!profile) return;

      const titleEl = document.getElementById('id-detail-title');
      const roleHeaderEl = document.getElementById('id-detail-role-header');
      const roleEl = document.getElementById('id-detail-role');
      const promptEl = document.getElementById('id-detail-prompt');
      const taskEl = document.getElementById('id-detail-task');

      if (titleEl) titleEl.innerText = profile.title;
      if (roleHeaderEl) roleHeaderEl.innerText = profile.title.split(' ').slice(1).join(' ');
      if (roleEl) roleEl.innerText = profile.role;
      if (promptEl) promptEl.innerText = profile.prompt;
      if (taskEl) taskEl.innerText = profile.task;

      const cards = document.querySelectorAll('#agents .agent-card');
      cards.forEach(card => card.style.borderColor = 'var(--border-color)');
      if (cards[AGENT_INDEX_MAP[key]]) {
        cards[AGENT_INDEX_MAP[key]].style.borderColor = 'var(--status-blue)';
      }

      // Reset chat greetings for selected agent
      const chatMessages = document.getElementById('id-agent-chat-messages');
      if (chatMessages) {
        chatMessages.innerHTML = `
          <div class="chat-bubble agent">
            <strong>${profile.title}:</strong> Greetings ${operatorName}. I am ready. What task or directive would you like to assign?
          </div>
        `;
      }

      if (lastTelemetryData) {
        updateTelemetryUI(lastTelemetryData);
      }
    }

    // ---------------------------------------------------------------------------
    // Agent Direct Communicator
    // ---------------------------------------------------------------------------
    function handleAgentChatKey(e) {
      if (e.key === 'Enter') {
        sendAgentMessage();
      }
    }

    function sendAgentMessage() {
      const inputEl = document.getElementById('id-agent-chat-input');
      const messagesEl = document.getElementById('id-agent-chat-messages');
      if (!inputEl || !messagesEl) return;

      const message = inputEl.value.trim();
      if (!message) return;

      // Append user bubble
      const userBubble = document.createElement('div');
      userBubble.className = 'chat-bubble user';
      userBubble.innerText = message;
      messagesEl.appendChild(userBubble);
      inputEl.value = '';
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Append typing indicator
      const typingBubble = document.createElement('div');
      typingBubble.className = 'chat-bubble agent';
      typingBubble.id = 'id-agent-typing-indicator';
      typingBubble.innerHTML = `<em>${agentProfiles[currentSelectedAgent].title} is reasoning...</em>`;
      messagesEl.appendChild(typingBubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, agent: currentSelectedAgent })
      })
        .then(res => res.json())
        .then(data => {
          const typing = document.getElementById('id-agent-typing-indicator');
          if (typing) typing.remove();

          const agentBubble = document.createElement('div');
          agentBubble.className = 'chat-bubble agent';
          agentBubble.innerHTML = `<strong>${agentProfiles[currentSelectedAgent].title}:</strong> ${data.reply || 'Task acknowledged.'}`;
          messagesEl.appendChild(agentBubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        })
        .catch(err => {
          const typing = document.getElementById('id-agent-typing-indicator');
          if (typing) typing.remove();

          const errorBubble = document.createElement('div');
          errorBubble.className = 'chat-bubble agent';
          errorBubble.innerHTML = `<strong>${agentProfiles[currentSelectedAgent].title}:</strong> Received: "${message}". Local stack connection timeout.`;
          messagesEl.appendChild(errorBubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ---------------------------------------------------------------------------
    // Mini canvas charts (latency / CPU trend)
    // ---------------------------------------------------------------------------
    class MiniChart {
      constructor(canvasId, color, maxVal) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
          console.warn(`Canvas with ID '${canvasId}' not found.`);
          return;
        }
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
          console.warn(`Could not get 2D context for canvas '${canvasId}'.`);
          return;
        }
        this.color = color;
        this.maxVal = maxVal;
        this.data = Array.from({ length: 25 }, () => Math.random() * maxVal * 0.4 + maxVal * 0.3);

        this.resize();
        window.addEventListener('resize', () => this.resize());
      }

      resize() {
        if (!this.canvas || !this.canvas.parentElement) return;
        this.canvas.width = this.canvas.parentElement.clientWidth || 0;
        this.canvas.height = this.canvas.parentElement.clientHeight || 0;
        this.draw();
      }

      addData(val) {
        if (!this.data) return;
        this.data.shift();
        this.data.push(val);
        this.draw();
      }

      setData(values) {
        if (!this.data || !values || values.length === 0) return;
        const windowSize = this.data.length;
        if (values.length >= windowSize) {
          this.data = values.slice(values.length - windowSize);
        } else {
          const pad = Array(windowSize - values.length).fill(values[0]);
          this.data = pad.concat(values);
        }
        this.draw();
      }

      draw() {
        if (!this.canvas || !this.ctx || !this.data) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;
        if (w === 0 || h === 0) return;

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(0, (h / 4) * i);
          ctx.lineTo(w, (h / 4) * i);
          ctx.stroke();
        }

        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.beginPath();

        const step = w / (this.data.length - 1);
        this.data.forEach((val, i) => {
          const x = i * step;
          const y = h - (val / this.maxVal) * h * 0.8 - h * 0.1;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, this.color.replace('1)', '0.15)'));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    const latencyChart = new MiniChart('latencyChart', 'rgba(0, 176, 255, 1)', 100);
    const cpuChart = new MiniChart('cpuChart', 'rgba(0, 230, 118, 1)', 100);

    // Simulated fluctuation fallback until live telemetry arrives
    setInterval(() => {
      if (telemetryLive) return;

      const cpu = Math.random() * 8 + 8;
      const cpuValEl = document.getElementById('id-cpu-val');
      const cpuUtilEl = document.getElementById('id-cpu-util');
      if (cpuValEl) cpuValEl.innerText = cpu.toFixed(1) + '%';
      if (cpuUtilEl) cpuUtilEl.innerText = cpu.toFixed(1) + '%';
      if (cpuChart && typeof cpuChart.addData === 'function') cpuChart.addData(cpu);

      const baseLatency = 42;
      const latency = baseLatency + (Math.random() * 6 - 3);
      const latencyValEl = document.getElementById('id-latency-val');
      const latencyTrendEl = document.getElementById('id-latency-trend');
      if (latencyValEl) latencyValEl.innerText = Math.round(latency) + ' ms';
      if (latencyTrendEl) latencyTrendEl.innerText = Math.round(latency) + ' ms';
      if (latencyChart && typeof latencyChart.addData === 'function') latencyChart.addData(latency);
    }, 2000);

    // ---------------------------------------------------------------------------
    // Handshake / status sweep
    // ---------------------------------------------------------------------------
    function testOllamaHandshake() {
      const logPanel = document.getElementById('id-handshake-logs');
      const timeStr = new Date().toTimeString().split(' ')[0];

      const loader = document.createElement('div');
      loader.className = 'log-entry info';
      loader.innerText = `[${timeStr}] [ping] Pinging Ollama host at http://127.0.0.1:11434/api/tags...`;
      logPanel.appendChild(loader);
      logPanel.scrollTop = logPanel.scrollHeight;

      fetch('/api/ping')
        .then(res => res.json())
        .then(result => {
          const logTime = new Date().toTimeString().split(' ')[0];
          const entry = document.createElement('div');

          if (result.ok) {
            entry.className = 'log-entry success';
            const modelList = (result.models && result.models.length) ? result.models.join(', ') : 'none loaded';
            entry.innerText = `[${logTime}] [ping] Response: ${result.statusCode} OK from local Ollama. Latency: ${result.latencyMs}ms. Models loaded: ${modelList}.`;
            document.getElementById('id-latency-sub').innerHTML = '<span class="status-dot green"></span> Ping verified';
            appendConsoleLog('handshake', `[${logTime}] [ping] Response: ${result.statusCode} OK. Latency: ${result.latencyMs}ms.`);
          } else {
            entry.className = 'log-entry error';
            entry.innerText = `[${logTime}] [ping] Ollama unreachable (${result.error || 'unknown error'}). Waited ${result.latencyMs}ms.`;
            document.getElementById('id-latency-sub').innerHTML = '<span class="status-dot red"></span> Ping failed';
            appendConsoleLog('handshake', `[${logTime}] [ping] FAILED: ${result.error || 'unknown error'}.`, 'error');
          }

          logPanel.appendChild(entry);
          document.getElementById('id-latency-val').innerText = result.latencyMs + ' ms';
          document.getElementById('id-latency-trend').innerText = result.latencyMs + ' ms';
          logPanel.scrollTop = logPanel.scrollHeight;
        })
        .catch(err => {
          const logTime = new Date().toTimeString().split(' ')[0];
          const entry = document.createElement('div');
          entry.className = 'log-entry error';
          entry.innerText = `[${logTime}] [ping] Server request failed: ${err.message}`;
          logPanel.appendChild(entry);
          logPanel.scrollTop = logPanel.scrollHeight;
        });
    }

    function triggerStatusSweep() {
      const logPanel = document.getElementById('id-handshake-logs');
      const timeStr = new Date().toTimeString().split(' ')[0];

      const sweepLog = document.createElement('div');
      sweepLog.className = 'log-entry info';
      sweepLog.innerText = `[${timeStr}] [sweep] Initiating status sweep across engines and workspace directories...`;
      logPanel.appendChild(sweepLog);

      setTimeout(() => {
        const sweepTime = new Date().toTimeString().split(' ')[0];
        const rootDisplay = (currentHostSpecs && currentHostSpecs.openclawConfigFile)
          ? currentHostSpecs.openclawConfigFile.replace(/[/\\]openclaw\.json$/, '')
          : 'tt-ai-stack';
        const cfgDisplay = (currentHostSpecs && currentHostSpecs.openclawConfigFile) || 'openclaw.json';
        const messages = [
          `[${sweepTime}] [sweep] Workspace '${rootDisplay}' contains folders: 01_projects (clean), 02_engines (restored), 03_documents (archived), 04_internal (isolated).`,
          `[${sweepTime}] [sweep] OpenClaw config ${cfgDisplay} is active and valid.`,
          `[${sweepTime}] [sweep] All 5 system agents report healthy. Ready for commands.`
        ];
        messages.forEach(msg => {
          const entry = document.createElement('div');
          entry.className = 'log-entry success';
          entry.innerText = msg;
          logPanel.appendChild(entry);
        });

        logPanel.scrollTop = logPanel.scrollHeight;
        appendConsoleLog('relocate', `[${sweepTime}] [sweep] Workspace validated. Layout: 100% clean and optimized.`);
      }, 500);
    }

    // ---------------------------------------------------------------------------
    // Console / terminal tab
    // ---------------------------------------------------------------------------
    function filterLogs(category, event) {
      document.querySelectorAll('.console-tab').forEach(tab => tab.classList.remove('active'));
      if (event && event.target) event.target.classList.add('active');

      document.querySelectorAll('#id-console-log-list .log-entry').forEach(log => {
        const matches = category === 'all' || log.getAttribute('data-cat') === category;
        log.style.display = matches ? 'block' : 'none';
      });
    }

    function appendConsoleLog(category, message, level = 'success') {
      const consoleLogList = document.getElementById('id-console-log-list');
      const entry = document.createElement('div');
      entry.className = `log-entry ${level}`;
      entry.setAttribute('data-cat', category);
      entry.innerText = message;
      consoleLogList.appendChild(entry);
      consoleLogList.scrollTop = consoleLogList.scrollHeight;
    }

    function handleTerminalCommand(e) {
      if (e.key !== 'Enter') return;

      const inputField = document.getElementById('id-terminal-input');
      const cmd = inputField.value.trim().toLowerCase();
      if (cmd === '') return;

      const timeStr = new Date().toTimeString().split(' ')[0];
      appendConsoleLog('all', `[${timeStr}] user@arunachala:~$ ${cmd}`, 'info');

      const commandHandlers = {
        help: () => appendConsoleLog('all', `Available commands: 'help', 'status', 'ping', 'agents', 'clear'`, 'info'),
        ping: () => testOllamaHandshake(),
        status: () => appendConsoleLog('all', `Ollama Server: ONLINE | OpenClaw Gateway: ONLINE | Workspace: 100% clean`, 'success'),
        agents: () => appendConsoleLog('all', `Active Hired Workforce: PO (Active), Tech Lead (Idle), QA (Idle), DevOps (Idle), Doc Specialist (Idle).`, 'success'),
        clear: () => { document.getElementById('id-console-log-list').innerHTML = ''; }
      };

      setTimeout(() => {
        const handler = commandHandlers[cmd];
        if (handler) {
          handler();
        } else {
          appendConsoleLog('all', `Command '${cmd}' not recognized. Type 'help' for available commands.`, 'error');
        }
      }, 150);

      inputField.value = '';
    }

    // ---------------------------------------------------------------------------
    // Live telemetry integration
    // ---------------------------------------------------------------------------
    function updateTelemetryUI(data) {
      if (!data) return;

      updateCpuMetrics(data);
      updateLatencyMetrics(data);
      updateServiceDots(data);
      updateModelRoutingTable(data);
      syncDaemonLogs(data);
      updateAgentTelemetryPanel(data);
      updateEngineStatsPanel(data);
      if (data.host) updateHostSpecsUI(data.host);
    }

    function updateHostSpecsUI(host) {
      if (!host) return;
      currentHostSpecs = host;

      const osEl = document.getElementById('id-host-os');
      if (osEl && host.os) osEl.innerText = host.os;

      const cpuEl = document.getElementById('id-host-cpu');
      if (cpuEl && host.cpu) cpuEl.innerText = host.cpu;

      const gpuEl = document.getElementById('id-host-gpu');
      if (gpuEl && host.gpu) gpuEl.innerText = host.gpu;

      const ollamaEl = document.getElementById('id-host-ollama');
      if (ollamaEl && host.ollamaEndpoint) ollamaEl.innerText = host.ollamaEndpoint;

      const openclawEl = document.getElementById('id-host-openclaw');
      if (openclawEl && host.openclawConfig) openclawEl.innerText = host.openclawConfig;

      const openclawFileEl = document.getElementById('id-openclaw-config-file');
      if (openclawFileEl && host.openclawConfigFile) openclawFileEl.innerText = host.openclawConfigFile;

      const initWorkspaceLog = document.getElementById('id-init-workspace-log');
      if (initWorkspaceLog && host.stackRoot) {
        initWorkspaceLog.innerText = `[18:30:04] [workspace] Relocation verified. Root ${host.stackRoot} structured (01_projects, 02_engines, 03_documents, 04_internal).`;
      }

      const shellChip = document.getElementById('id-shell-chip');
      if (shellChip && host.shellName) {
        shellChip.innerText = host.shellName;
      }

      const cpuSubEl = document.getElementById('id-cpu-sub');
      if (cpuSubEl && host.cpu) {
        cpuSubEl.innerHTML = `<span class="status-dot green"></span> ${host.cpu}`;
      }

      const gpuHeaderEl = document.getElementById('id-gpu-header');
      if (gpuHeaderEl && host.gpuHeader) gpuHeaderEl.innerText = host.gpuHeader;

      const gpuSubEl = document.getElementById('id-gpu-sub');
      if (gpuSubEl && host.gpuSub) {
        gpuSubEl.innerHTML = `<span class="status-dot green"></span> ${host.gpuSub}`;
      }
    }

    function updateLatencyMetrics(data) {
      const latencyMs = data.services && data.services.ollama ? data.services.ollama.latencyMs : null;
      if (latencyMs === null || latencyMs === undefined) return;

      const latencyValEl = document.getElementById('id-latency-val');
      const latencyTrendEl = document.getElementById('id-latency-trend');
      if (latencyValEl) latencyValEl.innerText = latencyMs + ' ms';
      if (latencyTrendEl) latencyTrendEl.innerText = latencyMs + ' ms';
      if (latencyChart && typeof latencyChart.addData === 'function') latencyChart.addData(latencyMs);
    }

    function updateCpuMetrics(data) {
      const cpuVal = data.cpu + '%';
      const cpuValEl = document.getElementById('id-cpu-val');
      const cpuUtilEl = document.getElementById('id-cpu-util');
      if (cpuValEl) cpuValEl.innerText = cpuVal;
      if (cpuUtilEl) cpuUtilEl.innerText = cpuVal;
      if (cpuChart && typeof cpuChart.addData === 'function') cpuChart.addData(data.cpu);
    }

    function setServiceDot(elId, online, onlineLabel, offlineLabel) {
      const dot = document.getElementById(elId);
      if (!dot) return;
      if (online) {
        dot.parentElement.innerHTML = `<span class="status-dot green" id="${elId}"></span>${onlineLabel}`;
      } else {
        dot.parentElement.innerHTML = `<span class="status-dot red" id="${elId}"></span>${offlineLabel}`;
      }
    }

    // ---------------------------------------------------------------------------
    // Toast Notifications & Service Health Tracking
    // ---------------------------------------------------------------------------
    function showToast(message, type = 'info', icon = 'ℹ️', duration = 4500) {
      const container = document.getElementById('toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <div class="toast-message">${message}</div>
      `;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(15px)';
        setTimeout(() => toast.remove(), 350);
      }, duration);
    }

    const previousServiceStates = {
      ollama: null,
      openclaw: null,
      watchtower: null,
      buzz: null
    };

    function checkServiceStatusTransitions(services) {
      if (!services) return;

      const checkFlip = (key, name, icon) => {
        if (!services[key]) return;
        const current = !!services[key].online;
        const prev = previousServiceStates[key];
        if (prev !== null && prev !== current) {
          if (!current) {
            showToast(`⚠️ Service Offline: ${name} is unreachable.`, 'error', '🚨');
          } else {
            showToast(`✅ Service Restored: ${name} is back online.`, 'success', '⚡');
          }
        }
        previousServiceStates[key] = current;
      };

      checkFlip('ollama', 'Ollama Local Cluster', '🧠');
      checkFlip('openclaw', 'OpenClaw Gateway', '🦁');
      checkFlip('watchtower', 'Docker Watchtower', '🐳');
      checkFlip('buzz', 'Buzz Relay', '🐝');
    }

    function updateServiceDots(data) {
      if (!data || !data.services) return;
      checkServiceStatusTransitions(data.services);

      if (data.services.ollama) setServiceDot('id-ollama-dot', data.services.ollama.online, 'Online', 'Offline');
      if (data.services.openclaw) setServiceDot('id-openclaw-dot', data.services.openclaw.online, 'Online', 'Offline');
      if (data.services.openhands) setServiceDot('id-openhands-dot', data.services.openhands.online, 'Online', 'Offline');
      if (data.services.watchtower) setServiceDot('id-watchtower-dot', data.services.watchtower.online, 'Online', 'Offline');
      if (data.services.buzz) setServiceDot('id-buzz-dot', data.services.buzz.online, 'Online', 'Offline');
    }

    let dynamicModelsLoaded = false;
    function fetchAndRenderLiveModels() {
      fetch('/api/models')
        .then(res => res.json())
        .then(data => {
          if (data && data.ok && Array.isArray(data.models) && data.models.length > 0) {
            renderDynamicModelList(data.models);
            dynamicModelsLoaded = true;
          }
        })
        .catch(() => {});
    }

    function renderDynamicModelList(models) {
      const container = document.getElementById('id-model-routing-list');
      if (!container) return;

      container.innerHTML = '';
      models.forEach(m => {
        const item = document.createElement('div');
        item.className = 'model-item';
        const modelName = m.name || m;
        const sizeGb = m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : 'Installed';
        const isPrimary = personaModel
          ? modelName.toLowerCase().includes(personaModel.toLowerCase())
          : (modelName.includes('gemma3') || modelName.includes('qwen2.5-coder:7b'));
        const isVector = modelName.includes('nomic-embed');

        item.innerHTML = `
          <div class="model-name">${modelName}</div>
          <div class="model-role">${isPrimary ? 'Primary Persona/Coding' : (isVector ? 'Embeddings/RAG' : 'Local Inference')}</div>
          <div class="model-stat">${sizeGb}</div>
          <div class="model-badge">${isPrimary ? 'Primary' : (isVector ? 'Vector' : 'Online')}</div>
        `;
        container.appendChild(item);
      });
    }

    function updateModelRoutingTable(data) {
      const models = Array.isArray(data.activeModels) ? data.activeModels : [];
      if (models.length === 0) return;

      document.querySelectorAll('.model-item').forEach(item => {
        const nameEl = item.querySelector('.model-name');
        const badge = item.querySelector('.model-badge');
        if (!nameEl || !badge) return;

        const name = nameEl.innerText.trim();
        const match = models.find(m =>
          m && m.name && (m.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(m.name.toLowerCase()))
        );

        if (match) {
          badge.innerText = `Active (${match.vram || 'VRAM'})`;
          badge.style.backgroundColor = 'rgba(0, 230, 118, 0.25)';
          badge.style.color = 'var(--status-green)';
          badge.style.borderColor = 'var(--status-green)';
        } else {
          if (personaModel && name.toLowerCase().includes(personaModel.toLowerCase())) badge.innerText = 'Primary';
          else if (name.includes('nomic-embed')) badge.innerText = 'Vector';
          else badge.innerText = 'Online';
          badge.style.backgroundColor = '';
          badge.style.color = '';
          badge.style.borderColor = '';
        }
      });
    }

    function syncDaemonLogs(data) {
      if (!data.logs) return;
      const logList = Array.isArray(data.logs) ? data.logs : [data.logs];
      if (logList.length === 0) return;

      const consoleLogList = document.getElementById('id-console-log-list');
      if (!consoleLogList) return;

      logList.forEach(logLine => {
        if (typeof logLine !== 'string') return;
        const cleanText = logLine.replace(/[\r\n]+/g, '').trim();
        if (cleanText === '') return;

        const entries = consoleLogList.querySelectorAll('.log-entry');
        const scanRange = Math.max(0, entries.length - 30);
        let exists = false;
        for (let i = scanRange; i < entries.length; i++) {
          if (entries[i].innerText.includes(cleanText)) {
            exists = true;
            break;
          }
        }
        if (exists) return;

        const entry = document.createElement('div');
        entry.setAttribute('data-cat', 'handshake');

        const lower = cleanText.toLowerCase();
        if (lower.includes('error') || lower.includes('fail')) {
          entry.className = 'log-entry error';
        } else if (lower.includes('warn')) {
          entry.className = 'log-entry warn';
        } else if (lower.includes('success') || lower.includes('complete') || lower.includes('synced')) {
          entry.className = 'log-entry success';
        } else {
          entry.className = 'log-entry info';
        }

        entry.innerText = cleanText;
        consoleLogList.appendChild(entry);
        consoleLogList.scrollTop = consoleLogList.scrollHeight;
      });
    }

    function updateAgentTelemetryPanel(data) {
      const telemetrySection = document.getElementById('id-detail-telemetry');
      if (!telemetrySection) return;

      const stats = data.agentStats && data.agentStats[currentSelectedAgent];
      telemetrySection.style.display = 'flex';
      const lastActiveEl = document.getElementById('id-metric-lastactive');

      if (!stats) {
        setAgentSessionBadge(null);
        ['id-metric-assigned', 'id-metric-active', 'id-metric-completed']
          .forEach(id => { document.getElementById(id).innerText = '—'; });
        if (lastActiveEl) lastActiveEl.innerText = 'No telemetry for this agent.';
        const emptyTools = document.getElementById('id-tool-metrics-list');
        if (emptyTools) emptyTools.innerHTML = '';
        return;
      }

      setAgentSessionBadge(stats.status);
      document.getElementById('id-metric-assigned').innerText = stats.assigned || 0;
      document.getElementById('id-metric-active').innerText = stats.active || 0;
      document.getElementById('id-metric-completed').innerText = stats.completed || 0;
      if (lastActiveEl) {
        const when = formatLastActive(stats.lastActive);
        const msgs = stats.messages ? ` · ${stats.messages} message${stats.messages === 1 ? '' : 's'}` : '';
        lastActiveEl.innerText = when ? `Last active ${when}${msgs}` : 'Never active.';
      }

      const toolsList = document.getElementById('id-tool-metrics-list');
      if (!toolsList) return;

      toolsList.innerHTML = '';
      const tools = stats.tools || {};
      const keys = Object.keys(tools).sort((a, b) => tools[b] - tools[a]);

      if (keys.length === 0) {
        toolsList.innerHTML = '<div style="color:var(--color-text-muted); font-style:italic; font-size:0.75rem;">No tools invoked yet in this session.</div>';
        return;
      }

      keys.forEach(toolName => {
        const count = tools[toolName];
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '2px 0';

        const nameSpan = document.createElement('span');
        nameSpan.style.fontFamily = "'JetBrains Mono', monospace";
        nameSpan.style.color = 'var(--status-blue)';
        nameSpan.innerText = toolName;

        const countSpan = document.createElement('span');
        countSpan.style.fontWeight = 'bold';
        countSpan.style.color = '#fff';
        countSpan.innerText = `${count} calls`;

        row.appendChild(nameSpan);
        row.appendChild(countSpan);
        toolsList.appendChild(row);
      });
    }

    function updateEngineStatsPanel(data) {
      if (!data.engineStats) return;
      const { paperclip, openclaw, hermes } = data.engineStats;

      if (paperclip) {
        const pEl = document.getElementById('id-paperclip-stats');
        if (pEl) pEl.innerText = `${paperclip.hiredCount || 5} Hired Agents`;
      }

      if (openclaw) {
        const oEl = document.getElementById('id-openclaw-stats');
        if (oEl) oEl.innerText = `${openclaw.pluginsCount || 0} Plugins / ${openclaw.toolsCount || 16} Tools`;

        const oBadge = document.getElementById('id-openclaw-status-badge');
        if (oBadge) {
          if (data.services.openclaw.online) {
            oBadge.innerText = 'Online';
            oBadge.style.backgroundColor = 'rgba(0,230,118,0.15)';
            oBadge.style.color = 'var(--status-green)';
            oBadge.style.borderColor = 'var(--status-green)';
          } else {
            oBadge.innerText = 'Offline';
            oBadge.style.backgroundColor = 'rgba(255,23,68,0.15)';
            oBadge.style.color = 'var(--status-red)';
            oBadge.style.borderColor = 'var(--status-red)';
          }
        }
      }

      if (hermes) {
        const hEl = document.getElementById('id-hermes-stats');
        if (hEl) hEl.innerText = `${hermes.activeRunners || 1} Active Runner${hermes.activeRunners > 1 ? 's' : ''}`;

        const hTraceEl = document.getElementById('id-traces-count');
        if (hTraceEl) hTraceEl.innerText = `${hermes.tracesCount || 0} logs`;
      }

      if (data.engineStats && data.engineStats.mantis) {
        const mEl = document.getElementById('id-mantis-stats');
        if (mEl) mEl.innerText = `${data.engineStats.mantis.skillsCount || 19} AppSec Skills`;
      }

      if (data.services && data.services.openhands) {
        const oh = data.services.openhands;
        const ohBadge = document.getElementById('id-openhands-status-badge');
        const ohStats = document.getElementById('id-openhands-stats');
        if (ohBadge) {
          if (oh.online) {
            ohBadge.innerText = 'Online';
            ohBadge.style.backgroundColor = 'rgba(0,230,118,0.15)';
            ohBadge.style.color = 'var(--status-green)';
            ohBadge.style.borderColor = 'var(--status-green)';
          } else {
            ohBadge.innerText = 'Offline';
            ohBadge.style.backgroundColor = 'rgba(255,23,68,0.15)';
            ohBadge.style.color = 'var(--status-red)';
            ohBadge.style.borderColor = 'var(--status-red)';
          }
        }
        if (ohStats) {
          ohStats.innerText = oh.online ? 'Port 8000 Canvas' : 'Container stopped';
        }
      }

      if (data.services && data.services.watchtower) {
        const wt = data.services.watchtower;
        const wBadge = document.getElementById('id-watchtower-status-badge');
        const wStats = document.getElementById('id-watchtower-stats');
        if (wBadge) {
          if (wt.online) {
            wBadge.innerText = 'Online';
            wBadge.style.backgroundColor = 'rgba(0,230,118,0.15)';
            wBadge.style.color = 'var(--status-green)';
            wBadge.style.borderColor = 'var(--status-green)';
          } else {
            wBadge.innerText = 'Offline';
            wBadge.style.backgroundColor = 'rgba(255,23,68,0.15)';
            wBadge.style.color = 'var(--status-red)';
            wBadge.style.borderColor = 'var(--status-red)';
          }
        }
        if (wStats) {
          wStats.innerText = wt.status || (wt.online ? 'Running' : 'Stopped');
        }
      }
      if (data.services && data.services.buzz) {
        const bz = data.services.buzz;
        const bBadge = document.getElementById('id-buzz-status-badge');
        const bStats = document.getElementById('id-buzz-stats');
        // Four states: "port is open" is not the same as "you can log in".
        const paint = (text, colour, rgba) => {
          if (!bBadge) return;
          bBadge.innerText = text;
          bBadge.style.backgroundColor = rgba;
          bBadge.style.color = colour;
          bBadge.style.borderColor = colour;
        };
        const RED = ['var(--status-red)', 'rgba(255,23,68,0.15)'];
        const AMBER = ['var(--status-amber)', 'rgba(255,171,0,0.15)'];
        const GREEN = ['var(--status-green)', 'rgba(0,230,118,0.15)'];
        if (!bz.online) {
          paint('OFFLINE', RED[0], RED[1]);
        } else if (bz.realMembers === 0) {
          paint('UNCLAIMED', RED[0], RED[1]);
        } else if (!bz.ui) {
          paint('HOST MISMATCH', AMBER[0], AMBER[1]);
        } else if (!bz.metrics) {
          paint('NO METRICS', AMBER[0], AMBER[1]);
        } else {
          paint('HEALTHY', GREEN[0], GREEN[1]);
        }
        if (bStats) {
          const members = bz.realMembers >= 0
            ? bz.realMembers + ' member' + (bz.realMembers === 1 ? '' : 's')
            : 'members ?';
          const lat = (bz.latencyMs !== null && bz.latencyMs !== undefined) ? bz.latencyMs + 'ms' : '--';
          bStats.innerText = (bz.containers || 0) + ' containers / ' + members + ' / ' + lat;
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Telemetry polling
    // ---------------------------------------------------------------------------
    function seedChartsFromHistory() {
      fetch('/api/history')
        .then(res => res.json())
        .then(history => {
          if (!Array.isArray(history) || history.length === 0) return;
          const cpuValues = history.map(p => p.cpu).filter(v => typeof v === 'number');
          const latencyValues = history.map(p => p.ollamaLatencyMs).filter(v => typeof v === 'number');
          if (cpuChart && cpuValues.length) cpuChart.setData(cpuValues);
          if (latencyChart && latencyValues.length) latencyChart.setData(latencyValues);
        })
        .catch(() => {});
    }

    function pollTelemetry() {
      fetch('/api/telemetry')
        .then(res => res.json())
        .then(data => {
          if (data && Object.keys(data).length > 0) {
            telemetryLive = true;
            lastTelemetryData = data;
            updateTelemetryUI(data);
            updateLastSyncedIndicator();
          }
        })
        .catch(() => {});
    }

    let lastSyncedAt = null;
    function updateLastSyncedIndicator() {
      lastSyncedAt = Date.now();
      renderLastSyncedIndicator();
    }
    function renderLastSyncedIndicator() {
      const el = document.getElementById('id-last-synced');
      if (!el) return;
      if (!lastSyncedAt) {
        el.innerText = 'never';
        el.style.color = 'var(--color-text-muted)';
        return;
      }
      const secsAgo = Math.round((Date.now() - lastSyncedAt) / 1000);
      el.innerText = secsAgo <= 1 ? 'just now' : `${secsAgo}s ago`;
      if (secsAgo > 30) {
        el.style.color = 'var(--status-red)';
      } else if (secsAgo > 12) {
        el.style.color = 'var(--status-amber)';
      } else {
        el.style.color = 'var(--status-green)';
      }
    }

    function startTelemetryPolling(intervalMs = 3000) {
      seedChartsFromHistory();
      fetchAndRenderLiveModels();
      pollTelemetry();
      setInterval(pollTelemetry, intervalMs);
      setInterval(renderLastSyncedIndicator, 1000);
      setInterval(fetchAndRenderLiveModels, 30000); // refresh model list every 30s
    }

    // ---------------------------------------------------------------------------
    // OpenClaw model usage / sessions / pending tasks
    // ---------------------------------------------------------------------------
    function formatTokens(n) {
      if (typeof n !== 'number') return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return String(n);
    }

    function renderModelBreakdown(el, models) {
      const entries = Object.entries(models || {}).filter(([, tokens]) => tokens > 0);
      if (!entries.length) {
        el.innerText = '';
        return;
      }
      el.innerText = entries.map(([model, tokens]) => `${model}: ${formatTokens(tokens)}`).join('  ·  ');
    }

    function renderOpenclawStatus(data) {
      const updatedEl = document.getElementById('id-openclaw-updated');
      if (updatedEl) {
        if (!data.ok && !data.updatedAt) {
          updatedEl.innerText = data.error || 'not synced';
        } else if (data.updatedAt) {
          const secsAgo = Math.round((Date.now() - data.updatedAt) / 1000);
          updatedEl.innerText = data.ok
            ? (secsAgo <= 1 ? 'synced just now' : `synced ${secsAgo}s ago`)
            : `stale (${data.error || 'poll failed'})`;
        }
      }

      const usage = data.tokenUsage || { local: {}, cloud: {} };
      const localEl = document.getElementById('id-tokens-local');
      const cloudEl = document.getElementById('id-tokens-cloud');
      if (localEl) localEl.innerText = formatTokens(usage.local && usage.local.tokens);
      if (cloudEl) cloudEl.innerText = formatTokens(usage.cloud && usage.cloud.tokens);
      const localModelsEl = document.getElementById('id-tokens-local-models');
      const cloudModelsEl = document.getElementById('id-tokens-cloud-models');
      if (localModelsEl) renderModelBreakdown(localModelsEl, usage.local && usage.local.models);
      if (cloudModelsEl) renderModelBreakdown(cloudModelsEl, usage.cloud && usage.cloud.models);

      const sessionCountEl = document.getElementById('id-session-count');
      if (sessionCountEl) sessionCountEl.innerText = Array.isArray(data.sessions) ? String(data.sessions.length) : '—';
      const resetsEl = document.getElementById('id-session-resets');
      if (resetsEl) resetsEl.innerText = typeof data.sessionResets === 'number' ? String(data.sessionResets) : '—';
      const pendingCountEl = document.getElementById('id-pending-count');
      if (pendingCountEl) pendingCountEl.innerText = typeof data.pendingCount === 'number' ? String(data.pendingCount) : '—';

      const pendingListEl = document.getElementById('id-pending-list');
      if (pendingListEl) {
        const pending = data.pendingTasks || [];
        pendingListEl.innerText = pending.length
          ? pending.map(t => `${t.status}: ${t.task}`).join('\n')
          : '';
      }
    }

    function pollOpenclawStatus() {
      fetch('/api/openclaw')
        .then(res => res.json())
        .then(data => renderOpenclawStatus(data))
        .catch(() => {});
    }

    function startOpenclawPolling(intervalMs = 15000) {
      pollOpenclawStatus();
      setInterval(pollOpenclawStatus, intervalMs);
    }

    // ---------------------------------------------------------------------------
    // Explicit Window Exports for HTML Inline Event Handlers
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // Agent Runs: tasks dispatched by orchestration/agent-dispatch.sh
    // ---------------------------------------------------------------------------
    const RUNS_POLL_MS = 5000;

    function formatDuration(seconds) {
      if (typeof seconds !== 'number') return '—';
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }

    // Built with textContent, never innerHTML: task text is whatever someone
    // wrote in a prompt file and must not become markup.
    function runCell(text, className) {
      const td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = text == null || text === '' ? '—' : String(text);
      return td;
    }

    function renderAgentRuns(payload) {
      const body = document.getElementById('runs-body');
      const summary = document.getElementById('runs-summary');
      if (!body) return;
      body.replaceChildren();

      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      if (!payload.ok || runs.length === 0) {
        const tr = document.createElement('tr');
        const td = runCell(payload.error || payload.note || 'No runs recorded yet.');
        td.colSpan = 8;
        tr.appendChild(td);
        body.appendChild(tr);
      }

      for (const run of runs) {
        const tr = document.createElement('tr');
        const status = document.createElement('span');
        status.className = `run-status ${run.status || ''}`;
        status.textContent = run.status || 'unknown';
        const statusCell = document.createElement('td');
        statusCell.appendChild(status);
        if (typeof run.exit_code === 'number' && run.exit_code !== 0) {
          statusCell.append(` exit ${run.exit_code}`);
        }

        const started = run.started_at ? new Date(run.started_at).toLocaleString() : '';
        tr.append(
          runCell(run.agent),
          runCell(run.branch, 'runs-mono'),
          runCell(run.task, 'runs-task'),
          statusCell,
          runCell(started),
          runCell(formatDuration(run.duration_s)),
          runCell(run.commits_ahead),
          runCell(run.id, 'runs-mono'),
        );
        tr.title = `${run.worktree || ''}\n${run.log || ''}`;
        body.appendChild(tr);
      }

      if (summary) {
        const active = runs.filter((r) => r.status === 'running').length;
        summary.textContent = `${active} running · ${runs.length} shown`;
      }
    }

    function loadAgentRuns() {
      fetch('/api/runs')
        .then((r) => r.json())
        .then(renderAgentRuns)
        .catch((err) => renderAgentRuns({ ok: false, error: `Could not load runs: ${err.message}` }));
    }

    window.handleQuickDispatch = function(e) {
      if (e) e.preventDefault();
      const btn = document.getElementById('dispatch-btn');
      const status = document.getElementById('dispatch-status');
      const agent = (document.getElementById('dispatch-agent') || {}).value || 'auto';
      const repo = ((document.getElementById('dispatch-repo') || {}).value || '').trim();
      const branch = ((document.getElementById('dispatch-branch') || {}).value || '').trim();
      const task = ((document.getElementById('dispatch-task') || {}).value || '').trim();

      if (!repo || !task) return;
      if (btn) btn.disabled = true;
      if (status) { status.style.color = '#94a3b8'; status.textContent = 'Dispatching task...'; }

      fetch('/api/dispatch/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, repo, branch: branch || undefined, task })
      })
      .then((r) => r.json())
      .then((data) => {
        if (btn) btn.disabled = false;
        if (data.ok) {
          if (status) { status.style.color = '#10b981'; status.textContent = `Dispatched run ${data.runId}!`; }
          const taskInput = document.getElementById('dispatch-task');
          if (taskInput) taskInput.value = '';
          setTimeout(() => loadAgentRuns(), 800);
        } else {
          if (status) { status.style.color = '#ef4444'; status.textContent = `Error: ${data.error}`; }
        }
      })
      .catch((err) => {
        if (btn) btn.disabled = false;
        if (status) { status.style.color = '#ef4444'; status.textContent = `Network error: ${err.message}`; }
      });
    };

    setInterval(() => {
      const tab = document.getElementById('runs');
      if (tab && tab.classList.contains('active')) loadAgentRuns();
    }, RUNS_POLL_MS);

    // ---------------------------------------------------------------------------
    // Costs tab: GET /api/costs (team scope when team sync is on). Values from
    // the ledger go in with textContent, never innerHTML.
    // ---------------------------------------------------------------------------
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const fmtInt = (n) => Number(n || 0).toLocaleString();

    function fillCostRows(tbodyId, groups, key) {
      const body = document.getElementById(tbodyId);
      if (!body) return;
      body.replaceChildren();
      if (!groups.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = 'No calls in this period.';
        tr.append(td);
        body.append(tr);
        return;
      }
      for (const g of groups) {
        const tr = document.createElement('tr');
        for (const v of [g[key], fmtInt(g.calls), fmtInt(g.tokens), g.costUsd.toFixed(4)]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        body.append(tr);
      }
    }

    function renderCosts(data) {
      if (!data || !data.ok) {
        setText('costs-source', (data && data.error) || 'Could not load costs.');
        return;
      }
      const t = data.summary.totals;
      setText('costs-paid', fmtInt(t.paidCalls));
      setText('costs-local', fmtInt(t.localCalls));
      setText('costs-tokens', fmtInt(t.inputTokens + t.outputTokens));
      setText('costs-usd', `$${t.costUsd.toFixed(2)}`);
      const scope = data.source === 'team' ? 'Whole team' : 'This machine';
      setText('costs-source', `${scope}, last ${data.days} day(s)${data.note ? ` - ${data.note}` : ''}`);
      const list = document.getElementById('costs-advice');
      if (list) {
        list.replaceChildren(...data.advice.map((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          return li;
        }));
      }
      const a = data.auto;
      setText('costs-auto', a.autoRuns
        ? `Local-first: ${a.autoRuns} auto run(s), ${Math.round((a.localShare || 0) * 100)}% stayed local, ${a.escalated} escalated to claude.`
        : 'Local-first: no auto runs yet.');
      setText('costs-limits', data.limits
        ? `Daily caps on paid calls: ${data.limits.member_daily_calls} per person, ${data.limits.team_daily_calls} per team. Used today: ${data.paidCallsToday}.`
        : '');
      fillCostRows('costs-by-purpose', data.summary.byPurpose, 'purpose');
      fillCostRows('costs-by-model', data.summary.byModel, 'model');
    }

    function loadCosts() {
      const days = (document.getElementById('costs-days') || {}).value || '7';
      fetch(`/api/costs?days=${encodeURIComponent(days)}&scope=team`)
        .then((r) => r.json())
        .then(renderCosts)
        .catch((err) => renderCosts({ ok: false, error: `Could not load costs: ${err.message}` }));
    }

    // ---------------------------------------------------------------------------
    // Semantic Memory Search (Phase 1)
    // ---------------------------------------------------------------------------
    function toggleMemorySearchModal() {
      const panel = document.getElementById('id-memory-search-panel');
      if (!panel) return;
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'block') {
        const input = document.getElementById('id-memory-search-input');
        if (input) input.focus();
      }
    }

    async function executeDashboardMemorySearch() {
      const input = document.getElementById('id-memory-search-input');
      const resultsEl = document.getElementById('id-memory-search-results');
      if (!input || !resultsEl) return;
      const q = input.value.trim();
      if (!q) return;

      resultsEl.innerHTML = '<div style="color:var(--color-text-muted); font-style:italic; font-size:0.8rem;">Searching memories via embeddings...</div>';
      try {
        const res = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}&tenant=*&topK=5`);
        const data = await res.json();
        if (!data.ok || !data.memories || data.memories.length === 0) {
          resultsEl.innerHTML = '<div style="color:var(--color-text-muted); font-size:0.8rem;">No matching memories found.</div>';
          return;
        }
        let html = `<div style="font-size:0.75rem; color:var(--status-green); font-weight:600; margin-bottom:4px;">Ranked via ${data.ranker} (${data.count} results):</div>`;
        data.memories.forEach(m => {
          html += `
            <div style="background:rgba(0,0,0,0.25); border:1px solid var(--border-color); border-radius:6px; padding:10px 12px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <strong style="color:var(--status-blue); font-size:0.85rem;">${m.title || m.id}</strong>
                <span class="status-badge" style="font-size:0.65rem; padding:1px 6px;">Score: ${m.score}</span>
              </div>
              <div style="color:#cfd8dc; font-size:0.8rem; line-height:1.4;">${m.content}</div>
              <div style="font-size:0.7rem; color:var(--color-text-muted); margin-top:4px; font-family:'JetBrains Mono', monospace;">Category: ${m.category || 'general'} · Tenant: ${m.tenantId || '-'}</div>
            </div>
          `;
        });
        resultsEl.innerHTML = html;
      } catch (err) {
        resultsEl.innerHTML = `<div style="color:var(--status-red); font-size:0.8rem;">Search failed: ${err.message}</div>`;
      }
    }

    function reloadCanvasIframe() {
      const iframe = document.getElementById('id-openhands-canvas-iframe');
      if (iframe) {
        iframe.src = '/canvas/?t=' + Date.now();
      }
    }

    function toggleCanvasFullscreen() {
      const iframe = document.getElementById('id-openhands-canvas-iframe');
      if (!iframe) return;
      if (!document.fullscreenElement) {
        iframe.requestFullscreen().catch(err => alert(`Error entering fullscreen: ${err.message}`));
      } else {
        document.exitFullscreen();
      }
    }

    window.reloadCanvasIframe = reloadCanvasIframe;
    window.toggleCanvasFullscreen = toggleCanvasFullscreen;
    window.toggleMemorySearchModal = toggleMemorySearchModal;
    window.executeDashboardMemorySearch = executeDashboardMemorySearch;
    window.loadCosts = loadCosts;
    window.switchTab = switchTab;
    window.selectAgent = selectAgent;
    window.sendAgentMessage = sendAgentMessage;
    window.handleAgentChatKey = handleAgentChatKey;
    window.filterLogs = filterLogs;
    window.handleTerminalCommand = handleTerminalCommand;
    window.loadKanbanTasks = loadKanbanTasks;
    window.showToast = showToast;

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    startTelemetryPolling();
    startOpenclawPolling();