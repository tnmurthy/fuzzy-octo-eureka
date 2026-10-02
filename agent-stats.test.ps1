# agent-stats.test.ps1 - tests for agent-stats.ps1
#
# Plain assertions rather than Pester: this machine has Pester 3.4 (Windows
# inbox) and CI's pwsh ships Pester 5, whose Should syntaxes are incompatible.
#
# Run:  powershell -NoProfile -File .\agent-stats.test.ps1   (or pwsh)
# Exits 1 on any failure.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-stats.ps1')

$script:Failures = 0
$script:Passes   = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Name)
    if ($Expected -eq $Actual) {
        $script:Passes++
    } else {
        $script:Failures++
        Write-Host "FAIL: $Name - expected [$Expected], got [$Actual]" -ForegroundColor Red
    }
}

$Now = [datetime]'2026-10-01T12:00:00'

function New-Line {
    param([string]$Type, [string[]]$Tools = @())
    $calls = @($Tools | ForEach-Object { @{ name = $_ } })
    return (@{ type = $Type; tool_calls = $calls } | ConvertTo-Json -Compress -Depth 5)
}

# --- Get-TranscriptSummary ---------------------------------------------------

$finished = @(
    (New-Line 'USER_INPUT'),
    (New-Line 'PLANNER_RESPONSE' @('view_file', 'list_dir')),
    (New-Line 'PLANNER_RESPONSE' @('view_file')),
    (New-Line 'PLANNER_RESPONSE')
)
$s = Get-TranscriptSummary -Lines $finished
Assert-Equal 1 $s.userMessages 'counts user messages'
Assert-Equal 2 $s.tools['view_file'] 'counts tool calls per tool'
Assert-Equal 1 $s.tools['list_dir'] 'counts each tool separately'
Assert-Equal $false $s.pending 'final response with no tool calls is not pending'

$midTool = @((New-Line 'USER_INPUT'), (New-Line 'PLANNER_RESPONSE' @('run_command')))
Assert-Equal $true (Get-TranscriptSummary -Lines $midTool).pending 'ends on an unanswered tool call -> pending'

$awaitingModel = @((New-Line 'PLANNER_RESPONSE'), (New-Line 'USER_INPUT'))
Assert-Equal $true (Get-TranscriptSummary -Lines $awaitingModel).pending 'ends on user input -> pending'

$withJunk = @((New-Line 'USER_INPUT'), 'not json {', (New-Line 'PLANNER_RESPONSE'), '')
$j = Get-TranscriptSummary -Lines $withJunk
Assert-Equal 1 $j.userMessages 'malformed and blank lines are skipped'
Assert-Equal $false $j.pending 'trailing blank line does not hide the real last event'

# --- Get-ConversationState ---------------------------------------------------

Assert-Equal 'active' (Get-ConversationState -Pending $false -LastWrite $Now.AddMinutes(-3) -Now $Now) 'written in the last 10 min -> active'
Assert-Equal 'active' (Get-ConversationState -Pending $true -LastWrite $Now.AddHours(-2) -Now $Now) 'pending within the dormancy window -> active'
Assert-Equal 'idle' (Get-ConversationState -Pending $false -LastWrite $Now.AddHours(-2) -Now $Now) 'finished recently -> idle'
Assert-Equal 'dormant' (Get-ConversationState -Pending $false -LastWrite $Now.AddDays(-30) -Now $Now) 'nothing for 30 days -> dormant'
Assert-Equal 'dormant' (Get-ConversationState -Pending $true -LastWrite $Now.AddDays(-130) -Now $Now) 'pending but untouched for months is abandoned, not active'

# --- Get-AgentStats (filesystem) ---------------------------------------------

$brain = Join-Path ([IO.Path]::GetTempPath()) ("agent-stats-test-" + [guid]::NewGuid())
try {
    function New-Conversation {
        param([string]$Id, [string[]]$Lines, [datetime]$LastWrite)
        $dir = Join-Path $brain "$Id/.system_generated/logs"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $file = Join-Path $dir 'transcript.jsonl'
        Set-Content -Path $file -Value $Lines -Encoding UTF8
        (Get-Item $file).LastWriteTime = $LastWrite
    }

    $techHeader = '{"type":"SYSTEM","note":"You are the Tech Lead (tech_lead)"}'
    $qaHeader   = '{"type":"SYSTEM","note":"You are the QA Engineer (qa_engineer)"}'

    # Two finished tech conversations: assigned must SUM across them (the old
    # code overwrote it per folder while summing tool calls).
    New-Conversation 'tech-a' @($techHeader, (New-Line 'USER_INPUT'), (New-Line 'PLANNER_RESPONSE' @('view_file')), (New-Line 'PLANNER_RESPONSE')) $Now.AddDays(-130)
    New-Conversation 'tech-b' @($techHeader, (New-Line 'USER_INPUT'), (New-Line 'USER_INPUT'), (New-Line 'PLANNER_RESPONSE' @('view_file')), (New-Line 'PLANNER_RESPONSE')) $Now.AddDays(-129)
    # One qa conversation that is genuinely working right now.
    New-Conversation 'qa-live' @($qaHeader, (New-Line 'USER_INPUT'), (New-Line 'PLANNER_RESPONSE' @('run_command'))) $Now.AddMinutes(-1)
    # An untagged conversation must be ignored.
    New-Conversation 'other' @('{"type":"SYSTEM"}', (New-Line 'USER_INPUT')) $Now

    $stats = Get-AgentStats -BrainDir $brain -Roles @('po', 'tech', 'qa') -PoConversationId 'po-id' -Now $Now

    Assert-Equal 2 $stats['tech'].conversations 'tech has two conversations'
    Assert-Equal 2 $stats['tech'].assigned 'assigned counts conversations, the same unit as active/completed'
    Assert-Equal 3 $stats['tech'].messages 'messages sums user messages across conversations'
    Assert-Equal $stats['tech'].assigned ($stats['tech'].active + $stats['tech'].completed) 'assigned = active + completed when nothing is abandoned'
    Assert-Equal 2 $stats['tech'].completed 'both finished tech conversations count as completed'
    Assert-Equal 0 $stats['tech'].active 'nothing tech is active'
    Assert-Equal 2 $stats['tech'].tools['view_file'] 'tool calls sum across conversations'
    Assert-Equal 'dormant' $stats['tech'].status 'tech last touched 129 days ago -> dormant'
    Assert-Equal '2026-05-25T12:00:00' $stats['tech'].lastActive 'lastActive is the most recent conversation'

    Assert-Equal 1 $stats['qa'].active 'qa conversation in progress counts as active'
    Assert-Equal 0 $stats['qa'].completed 'an in-progress conversation is not completed'
    Assert-Equal 'active' $stats['qa'].status 'qa is active'

    Assert-Equal 0 $stats['po'].conversations 'role with no transcripts still reported'
    Assert-Equal 'none' $stats['po'].status 'role with no transcripts has status none'
    Assert-Equal $null $stats['po'].lastActive 'role with no transcripts has no lastActive'

    $missing = Get-AgentStats -BrainDir (Join-Path $brain 'nope') -Roles @('po') -PoConversationId 'x' -Now $Now
    Assert-Equal 'none' $missing['po'].status 'missing brain dir does not throw'
}
finally {
    Remove-Item -Recurse -Force $brain -ErrorAction SilentlyContinue
}

Write-Host "agent-stats: $script:Passes passed, $script:Failures failed"
if ($script:Failures -gt 0) { exit 1 }
