// Fixed, extension-owned worker. Request data and credentials arrive only over stdin.
// No repository scripts, profiles, execution-policy overrides or certificate overrides.
export const powerShellProbeScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Net.Http
function Send-ProbeRecord($Value) {
    [Console]::WriteLine((ConvertTo-Json -InputObject $Value -Depth 5 -Compress))
}
function Wait-ProbeOperation($Task, $Watch, $Limit) {
    $remaining = $Limit - [int]$Watch.ElapsedMilliseconds
    if ($remaining -le 0 -or !$Task.Wait($remaining)) { throw [TimeoutException]::new() }
    $Task.GetAwaiter().GetResult()
}
$handler = New-Object Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMilliseconds(-1)
Send-ProbeRecord @{ type = 'ready'; version = $PSVersionTable.PSVersion.ToString(); clrVersion = [Environment]::Version.ToString(); useProxy = $handler.UseProxy; checkCertificateRevocationList = $handler.CheckCertificateRevocationList }
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        if ($line.Length -gt 100000) { break }
        $inputData = ConvertFrom-Json -InputObject $line
        $line = $null
        $address = $null
        if (![Uri]::TryCreate([string]$inputData.url, [UriKind]::Absolute, [ref]$address) -or $address.Scheme -ne 'https' -or $address.UserInfo -or $address.Query -or $address.Fragment) { break }
        $limit = [int]$inputData.timeoutMs
        if ($limit -lt 1 -or $limit -gt 90000) { break }
        if ($inputData.encoding -notin @('default','identity')) { break }
        $request = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Post, $address)
        $request.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', ([string]$inputData.key))
        if ($inputData.encoding -eq 'identity') { [void]$request.Headers.TryAddWithoutValidation('Accept-Encoding', 'identity') }
        $request.Content = New-Object Net.Http.StringContent([string]$inputData.body, [Text.Encoding]::UTF8, 'application/json')
        # Match the production Content-Type as well as the exact UTF-8 body bytes.
        $request.Content.Headers.ContentType.CharSet = $null
        $inputData = $null
        $response = $null; $stream = $null
        $cancel = New-Object Threading.CancellationTokenSource
        $cancel.CancelAfter($limit)
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $stage = 'request'; $reason = 'transport'; $bytes = 0; $first = $null; $headerTime = $null
        try {
            $response = Wait-ProbeOperation ($client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token)) $watch $limit
            $headerTime = $watch.ElapsedMilliseconds
            $headers = @{}
            # The host normalizes these values to categories before export.
            foreach ($name in @('Content-Type','Content-Encoding','Content-Length')) {
                if ($response.Content.Headers.Contains($name)) { $headers[$name] = ($response.Content.Headers.GetValues($name) -join ',') }
            }
            if ($response.Headers.TransferEncodingChunked) { $headers['Transfer-Encoding'] = 'chunked' }
            Send-ProbeRecord @{ type = 'headers'; status = [int]$response.StatusCode; headers = $headers; headersMs = $headerTime; httpVersion = $response.Version.ToString() }
            $stage = 'body-read'
            $stream = Wait-ProbeOperation ($response.Content.ReadAsStreamAsync()) $watch $limit
            # HttpClient defaults do not advertise compression. Decode an unsolicited
            # encoding so the shared completion decoder still sees decoded body bytes.
            $encoding = ($response.Content.Headers.ContentEncoding -join ',').ToLowerInvariant()
            if ($encoding -eq 'gzip') { $stream = New-Object IO.Compression.GZipStream($stream, [IO.Compression.CompressionMode]::Decompress) }
            elseif ($encoding -eq 'deflate' -and ('System.IO.Compression.ZLibStream' -as [type])) { $stream = New-Object IO.Compression.ZLibStream($stream, [IO.Compression.CompressionMode]::Decompress) }
            elseif ($encoding -eq 'br' -and ('System.IO.Compression.BrotliStream' -as [type])) { $stream = New-Object IO.Compression.BrotliStream($stream, [IO.Compression.CompressionMode]::Decompress) }
            elseif ($encoding -and $encoding -ne 'identity') { $reason = 'unsupported-encoding'; throw [IO.InvalidDataException]::new() }
            $buffer = New-Object byte[] 8192
            $tail = ''
            while ($true) {
                $count = Wait-ProbeOperation ($stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)) $watch $limit
                if (!$count) { break }
                $at = $watch.ElapsedMilliseconds
                if ($null -eq $first) { $first = $at }
                $bytes += $count
                if ($bytes -gt 1000000) { $reason = 'body-limit'; throw [IO.InvalidDataException]::new() }
                Send-ProbeRecord @{ type = 'chunk'; data = [Convert]::ToBase64String($buffer, 0, $count) }
                $framing = $tail + [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
                if ($framing -match '(?m)^data:[ \t]*\[DONE\][ \t]*\r?$') { break }
                $tail = $framing.Substring([Math]::Max(0, $framing.Length - 100))
            }
            Send-ProbeRecord @{ type = 'done'; headersMs = $headerTime; firstBodyByteMs = $first; elapsedMs = $watch.ElapsedMilliseconds; bodyBytes = $bytes }
        } catch {
            $codes = @(); $exception = $_.Exception
            for ($i = 0; $i -lt 8 -and $null -ne $exception; $i++) {
                if ($exception -is [Net.Sockets.SocketException]) { $codes += [int]$exception.NativeErrorCode }
                $exception = $exception.InnerException
            }
            Send-ProbeRecord @{ type = 'failure'; stage = $stage; reason = $reason; timeout = ($watch.ElapsedMilliseconds -ge ($limit - 50) -or $cancel.IsCancellationRequested); socketCodes = @($codes); elapsedMs = $watch.ElapsedMilliseconds }
        } finally {
            $cancel.Cancel(); $cancel.Dispose()
            if ($stream) { $stream.Dispose() }
            if ($response) { $response.Dispose() }
            $request.Dispose()
        }
    }
} finally { $client.Dispose() }
`;
