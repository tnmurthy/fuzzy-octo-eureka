# agent-stats.ps1 - per-role agent statistics from Antigravity transcripts.
#
# Dot-sourced by telemetry-daemon.ps1. Functions only, no side effects, so it
# can be tested without starting the polling loop (see agent-stats.test.ps1).
#
# Replaces an earlier version whose numbers were arithmetic, not observation:
#   - active was hard-coded to 1 for any transcript with a user message, so
#     sessions that finished in May still showed as active in October;
#   - completed was assigned - 1;
#   - assigned was overwritten per conversation folder while tool counts were
#     summed, so a role could show "1 assigned" beside 164 tool calls.
#
# Here assigned, active and completed all count conversations, so they add
# up; the user-message total is reported separately as `messages`.
#
# Compatible with Windows PowerShell 5.1 (no ternaries or ?? operators).

$script:AgentActiveMinutes = 10
$script:AgentDormantDays   = 7

function Get-RoleKeyFromFirstLine {
    param([string]$FirstLine, [string]$ConversationId, [string]$PoConversationId)

    if ($ConversationId -eq $PoConversationId)                         { return "po" }
    if ($FirstLine -match "tech_lead|Tech Lead")                       { return "tech" }
    if ($FirstLine -match "qa_engineer|QA Engineer")                   { return "qa" }
    if ($FirstLine -match "doc_specialist|Documentation Specialist")   { return "doc" }
    if ($FirstLine -match "infra_expert|Infrastructure Specialist")    { return "infra" }
    return ""
}

function Get-TranscriptSummary {
    # Counts user messages and tool calls, and decides whether the conversation
    # is waiting on something: it ends on a user message (model owes a reply)
    # or on a response that requested tools (tools owe a result).
    param([string[]]$Lines)

    $userMessages = 0
    $tools = @{}
    $lastType = $null
    $lastToolCalls = 0

    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $obj = ConvertFrom-Json $line -ErrorAction Stop
        } catch {
            continue  # malformed line; ignore rather than fail the whole scan
        }
        if ($null -eq $obj -or $null -eq $obj.type) { continue }

        $lastType = $obj.type
        $lastToolCalls = 0

        if ($obj.type -eq 'USER_INPUT') {
            $userMessages++
        } elseif ($obj.type -eq 'PLANNER_RESPONSE') {
            foreach ($tc in @($obj.tool_calls)) {
                if ($null -eq $tc -or $null -eq $tc.name) { continue }
                $lastToolCalls++
                if ($tools.ContainsKey($tc.name)) { $tools[$tc.name] += 1 } else { $tools[$tc.name] = 1 }
            }
        }
    }

    $pending = ($lastType -eq 'USER_INPUT') -or ($lastType -eq 'PLANNER_RESPONSE' -and $lastToolCalls -gt 0)

    return @{ userMessages = $userMessages; tools = $tools; pending = $pending }
}

function Get-ConversationState {
    # dormant: untouched for AgentDormantDays, even if it ended mid-task -
    #          a tool call left unanswered for months is abandoned, not running.
    # active:  written in the last AgentActiveMinutes, or still waiting on a step.
    # idle:    finished cleanly, recently.
    param([bool]$Pending, [datetime]$LastWrite, [datetime]$Now)

    $age = $Now - $LastWrite
    if ($age.TotalDays -ge $script:AgentDormantDays) { return 'dormant' }
    if ($Pending -or $age.TotalMinutes -lt $script:AgentActiveMinutes) { return 'active' }
    return 'idle'
}

function Get-AgentStats {
    param(
        [string]$BrainDir,
        [string[]]$Roles,
        [string]$PoConversationId,
        [datetime]$Now = (Get-Date)
    )

    $stats = @{}
    foreach ($r in $Roles) {
        $stats[$r] = @{
            # assigned/active/completed all count conversations, so they add up.
            # messages is the user-message total, reported separately.
            assigned = 0; completed = 0; active = 0; conversations = 0; messages = 0
            tools = @{}; status = 'none'; lastActive = $null
        }
    }
    if (-not (Test-Path $BrainDir)) { return $stats }

    $latest = @{}
    foreach ($folder in (Get-ChildItem -Path $BrainDir -Directory -ErrorAction SilentlyContinue)) {
        $transcript = Join-Path $folder.FullName ".system_generated/logs/transcript.jsonl"
        if (-not (Test-Path $transcript)) {
            $transcript = Join-Path $folder.FullName ".system_generated/logs/transcript_full.jsonl"
        }
        if (-not (Test-Path $transcript)) { continue }

        $firstLine = Get-Content $transcript -TotalCount 1 -ErrorAction SilentlyContinue
        $role = Get-RoleKeyFromFirstLine -FirstLine $firstLine -ConversationId $folder.Name -PoConversationId $PoConversationId
        if ($role -eq "" -or -not $stats.ContainsKey($role)) { continue }

        try {
            $lines = Get-Content $transcript -ErrorAction Stop
        } catch {
            continue
        }

        $summary   = Get-TranscriptSummary -Lines $lines
        $lastWrite = (Get-Item $transcript).LastWriteTime
        $state     = Get-ConversationState -Pending $summary.pending -LastWrite $lastWrite -Now $Now

        $s = $stats[$role]
        $s.conversations += 1
        $s.assigned      += 1
        $s.messages      += $summary.userMessages
        foreach ($name in $summary.tools.Keys) {
            if ($s.tools.ContainsKey($name)) { $s.tools[$name] += $summary.tools[$name] } else { $s.tools[$name] = $summary.tools[$name] }
        }
        if ($state -eq 'active') {
            $s.active += 1
        } elseif (-not $summary.pending) {
            $s.completed += 1  # finished cleanly; abandoned mid-task does not count
        }

        if (-not $latest.ContainsKey($role) -or $lastWrite -gt $latest[$role]) {
            $latest[$role] = $lastWrite
        }
    }

    foreach ($role in $latest.Keys) {
        $s = $stats[$role]
        $s.lastActive = $latest[$role].ToString('yyyy-MM-ddTHH:mm:ss')
        if ($s.active -gt 0) {
            $s.status = 'active'
        } elseif (($Now - $latest[$role]).TotalDays -ge $script:AgentDormantDays) {
            $s.status = 'dormant'
        } else {
            $s.status = 'idle'
        }
    }

    return $stats
}
