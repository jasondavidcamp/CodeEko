#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Endpoint,
    [string]$Model,
    [Security.SecureString]$ApiKey,
    [ValidateRange(1, 600)][int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
if (!$Endpoint) { $Endpoint = Read-Host 'API base URL from EKOD settings' }
if (!$Model) { $Model = Read-Host 'Exact model ID from EKOD settings' }
$Endpoint = $Endpoint.Trim().TrimEnd('/')
$Model = $Model.Trim()
if (!$Model) { throw 'A model ID is required.' }
$address = $null
if (![Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$address) -or
    $address.Scheme -ne 'https' -or $address.UserInfo -or $address.Query -or $address.Fragment) {
    throw 'Use an HTTPS API base URL without credentials, query parameters or fragments.'
}
if ($address.AbsolutePath -notmatch '/v\d+(?:(?:alpha|beta)\d*)?(?:/|$)') { $Endpoint += '/v1' }
if (!$ApiKey) { $ApiKey = Read-Host 'API key' -AsSecureString }

function Wait-ProbeTask {
    param($Task, [Diagnostics.Stopwatch]$Watch)
    $remaining = ($TimeoutSeconds * 1000) - [int]$Watch.ElapsedMilliseconds
    if ($remaining -le 0 -or !$Task.Wait($remaining)) {
        throw [TimeoutException]::new('Probe deadline reached.')
    }
    $Task.GetAwaiter().GetResult()
}

function Receive-ProbeEvent {
    param([string]$Data, $State, $Report, [Diagnostics.Stopwatch]$Watch)
    if (!$Data.Trim()) { return }
    if ($Data.Trim() -eq '[DONE]') { $Report.doneMarker = $true; return }
    try { $item = ConvertFrom-Json -InputObject $Data -ErrorAction Stop }
    catch { $Report.malformedEvents++; return }
    $Report.events++
    if ($item.error) { $Report.providerError = $true }
    foreach ($choice in $item.choices) {
        if ($choice.finish_reason) { $Report.finishReasonReceived = $true }
        $part = $choice.delta.content
        if ($part -is [string] -and $part.Length -gt 0) {
            $seconds = [Math]::Round($Watch.Elapsed.TotalSeconds, 3)
            if ($null -eq $Report.firstTextSeconds) { $Report.firstTextSeconds = $seconds }
            $Report.lastTextSeconds = $seconds
            $Report.contentChunks++
            if ($State.Times.Count -lt 20) { [void]$State.Times.Add($seconds) }
            [void]$State.Text.Append($part)
        }
    }
}

function Receive-ProbeLine {
    param([string]$Line, $State, $Report, [Diagnostics.Stopwatch]$Watch)
    if ($Line -eq '') {
        if ($State.Event.Length -gt 0) {
            Receive-ProbeEvent $State.Event.ToString() $State $Report $Watch
            [void]$State.Event.Clear()
        }
        return
    }
    if ($Line -match '^(data:|event:|id:|retry:|:)') { $State.Sse = $true }
    if ($Line.StartsWith('data:')) {
        $value = $Line.Substring(5)
        if ($value.StartsWith(' ')) { $value = $value.Substring(1) }
        if ($State.Event.Length -gt 0) { [void]$State.Event.Append("`n") }
        [void]$State.Event.Append($value)
    }
}

function Invoke-StreamingProbe {
    param([bool]$Streaming, [string]$Key)
    $report = [ordered]@{
        test = $(if ($Streaming) { 'streaming' } else { 'normal' })
        timeoutSeconds = $TimeoutSeconds
        httpStatus = $null
        advertisedEventStream = $false
        bodyFormat = 'unknown'
        headerBodyMismatch = $false
        headersSeconds = $null
        firstBodySeconds = $null
        firstTextSeconds = $null
        lastTextSeconds = $null
        totalSeconds = $null
        bodyCharacters = 0
        events = 0
        contentChunks = 0
        first20ContentChunkSeconds = @()
        contentCharacters = 0
        doneMarker = $false
        finishReasonReceived = $false
        malformedEvents = 0
        providerError = $false
        validJson = $false
        expectedAction = $false
        outcome = 'pending'
    }
    $state = @{
        Sse = $false
        Event = New-Object Text.StringBuilder
        Text = New-Object Text.StringBuilder
        Times = New-Object 'Collections.Generic.List[double]'
    }
    $body = New-Object Text.StringBuilder
    $pending = ''
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds(-1)
    $request = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Post, "$Endpoint/chat/completions")
    $response = $null
    $reader = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stage = 'request'
    try {
        $request.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Key)
        $prompt = 'Return exactly one JSON object without markdown: {"version":1,"tool":"complete_task","args":{"summary":"YOUR ANSWER"}}. In summary, explain how rain forms in approximately 150 words.'
        $payload = @{
            model = $Model
            messages = @(@{ role = 'user'; content = $prompt })
            temperature = 0
            max_tokens = 4096
            stream = $Streaming
        } | ConvertTo-Json -Depth 8 -Compress
        $request.Content = New-Object Net.Http.StringContent($payload, [Text.Encoding]::UTF8, 'application/json')
        $response = Wait-ProbeTask ($client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead)) $watch
        $report.headersSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
        $report.httpStatus = [int]$response.StatusCode
        $report.advertisedEventStream = $response.Content.Headers.ContentType.MediaType -eq 'text/event-stream'
        if (!$response.IsSuccessStatusCode) {
            $report.outcome = 'http-error'
        } else {
            $stage = 'body-read'
            $stream = Wait-ProbeTask ($response.Content.ReadAsStreamAsync()) $watch
            $reader = New-Object IO.StreamReader($stream)
            $buffer = New-Object char[] 4096
            while (!$report.doneMarker) {
                $count = Wait-ProbeTask ($reader.ReadAsync($buffer, 0, $buffer.Length)) $watch
                if ($count -eq 0) { break }
                if ($null -eq $report.firstBodySeconds) {
                    $report.firstBodySeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
                }
                $report.bodyCharacters += $count
                if ($report.bodyCharacters -gt 1000000) {
                    $report.outcome = 'response-too-large'
                    break
                }
                $chunk = -join $buffer[0..($count - 1)]
                [void]$body.Append($chunk)
                $pending += $chunk
                # Detect SSE by its framing, regardless of the content-type header.
                while (($newline = $pending.IndexOf("`n")) -ge 0) {
                    $line = $pending.Substring(0, $newline).TrimEnd([char]13)
                    $pending = $pending.Substring($newline + 1)
                    Receive-ProbeLine $line $state $report $watch
                    if ($report.doneMarker) { break }
                }
            }
            if ($report.outcome -eq 'pending') {
                $stage = 'body-parse'
                if ($pending) { Receive-ProbeLine $pending $state $report $watch }
                if ($state.Event.Length -gt 0) { Receive-ProbeEvent $state.Event.ToString() $state $report $watch }
                if ($state.Sse) {
                    $report.bodyFormat = 'sse'
                    $report.headerBodyMismatch = !$report.advertisedEventStream
                    $report.outcome = if ($report.providerError) { 'provider-error' }
                        elseif ($report.malformedEvents) { 'malformed-sse' }
                        elseif (!$report.doneMarker -and !$report.finishReasonReceived) { 'incomplete-sse' }
                        else { 'stream-ended' }
                } else {
                    try { $data = ConvertFrom-Json -InputObject $body.ToString() -ErrorAction Stop }
                    catch { $report.outcome = 'body-not-json-or-sse'; $data = $null }
                    if ($null -ne $data) {
                        $report.bodyFormat = 'json'
                        $report.headerBodyMismatch = $report.advertisedEventStream
                        $report.providerError = [bool]$data.error
                        $part = $data.choices[0].message.content
                        if ($part -is [string] -and $part.Length -gt 0) {
                            [void]$state.Text.Append($part)
                            $report.contentChunks = 1
                            $report.firstTextSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
                            $report.lastTextSeconds = $report.firstTextSeconds
                        }
                        $report.finishReasonReceived = [bool]$data.choices[0].finish_reason
                        $report.outcome = if ($report.providerError) { 'provider-error' }
                            elseif ($Streaming) { 'non-stream-response' } else { 'response-received' }
                    }
                }
                try {
                    $action = ConvertFrom-Json -InputObject $state.Text.ToString() -ErrorAction Stop
                    $report.validJson = $null -ne $action
                    $report.expectedAction = $action.version -eq 1 -and $action.tool -eq 'complete_task' -and $action.args.summary -is [string]
                } catch {}
            }
        }
    } catch {
        # Never print arbitrary transport exceptions, bodies, URLs or headers.
        $report.outcome = if ($watch.ElapsedMilliseconds -ge ($TimeoutSeconds * 1000)) { 'timeout' }
            elseif ($stage -eq 'body-read') { 'body-read-error' }
            elseif ($stage -eq 'body-parse') { 'body-parse-error' }
            else { 'request-error' }
    } finally {
        $report.totalSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
        $report.contentCharacters = $state.Text.Length
        $report.first20ContentChunkSeconds = @($state.Times.ToArray())
        if ($state.Sse) { $report.bodyFormat = 'sse'; $report.headerBodyMismatch = !$report.advertisedEventStream }
        $client.CancelPendingRequests()
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
    }
    [PSCustomObject]$report
}

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKey)
try { $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
try {
    $results = @(Invoke-StreamingProbe $false $plainKey; Invoke-StreamingProbe $true $plainKey)
    [PSCustomObject]@{ probeVersion = 2; results = $results } | ConvertTo-Json -Depth 8
} finally { $plainKey = $null }
