# PostgreSQL control for the local dev cluster in tools/pgdata.
#
#   npm run db:start | db:stop | db:status
#
# The port (5433) lives in tools/pgdata/postgresql.conf, so no -o argument is needed here.
#
# Why this is a script rather than a direct pg_ctl call in package.json: on Windows the started
# server inherits the console handles of whatever launched it. Under npm - which pipes stdout -
# that means `npm run db:start` never returns, even though the database started fine. Launching
# through Start-Process detaches those handles, and polling the port lets us report readiness
# immediately instead of waiting on pg_ctl.

param([ValidateSet('start', 'stop', 'status')][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pgCtl = Join-Path $root 'tools\pgsql\bin\pg_ctl.exe'
$pgData = 'tools/pgdata'
$port = 5433

if (-not (Test-Path $pgCtl)) {
    Write-Host "PostgreSQL is not installed at tools\pgsql." -ForegroundColor Red
    Write-Host "See README-MIGRATION.md - the toolchain in tools/ is gitignored and may need reinstalling."
    exit 1
}

function Test-Port {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port)
        $c.Close()
        return $true
    } catch { return $false }
}

switch ($Action) {
    'status' {
        if (Test-Port) { Write-Host "PostgreSQL is running on port $port." -ForegroundColor Green; exit 0 }
        Write-Host "PostgreSQL is not running."; exit 1
    }

    'start' {
        if (Test-Port) { Write-Host "PostgreSQL is already running on port $port." -ForegroundColor Green; exit 0 }

        Start-Process -FilePath $pgCtl `
            -ArgumentList '-D', $pgData, '-l', 'tools/pg.log', 'start' `
            -WindowStyle Hidden

        # Report ready as soon as the port actually accepts a connection.
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-Port) {
                Write-Host "PostgreSQL started on port $port." -ForegroundColor Green
                exit 0
            }
        }

        Write-Host "PostgreSQL did not come up within 30s. Last lines of tools\pg.log:" -ForegroundColor Red
        Get-Content 'tools\pg.log' -Tail 10 -ErrorAction SilentlyContinue
        exit 1
    }

    'stop' {
        if (-not (Test-Port)) { Write-Host "PostgreSQL is not running."; exit 0 }

        Start-Process -FilePath $pgCtl -ArgumentList '-D', $pgData, '-w', 'stop' -WindowStyle Hidden

        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Milliseconds 500
            if (-not (Test-Port)) { Write-Host "PostgreSQL stopped." -ForegroundColor Green; exit 0 }
        }

        Write-Host "PostgreSQL did not stop within 30s." -ForegroundColor Red
        exit 1
    }
}
