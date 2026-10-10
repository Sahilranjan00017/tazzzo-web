// J5-J10: synchronous import, asynchronous import jobs (end to end, invalid rows, resume, cancel), errors.csv.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendCsv,
  call,
  check,
  createJob,
  docker,
  getJob,
  jobAction,
  journey,
  log,
  pub,
  productBody,
  RUN,
  S,
  section,
  sh,
  sleep,
  waitJob,
  blocked,
} from './support'

const hdr = 'id,title,brand,internalKey,vertical,release,classification'
const csvRow = (id: string, title: string, key: string) =>
  `${id},${title},E2E,${key},TZV-000001,R1,confirmed`
const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

journey(
  'J05',
  'normal (synchronous) product import: dry run, apply, UNCHANGED re-submit',
  async () => {
    const rows = ['Alpha', 'beta', 'GAMMA'].map((w, i) =>
      productBody(`TZP-Sync-${w}-${RUN}`, `Sync import ${w} ${RUN}`),
    )
    const dry = await call('POST', '/api/v1/admin/imports/products', {
      body: { dryRun: true, rows },
    })
    check(
      'dry run -> 200, every row VALID, nothing written',
      dry.status === 200 &&
        dry.body.results.every((r: any) => r.outcome === 'VALID') &&
        dry.body.applied === 0,
      dry.body,
    )
    const g0 = await call('GET', `/api/v1/products/${rows[0]!.id}`, { quiet: true })
    check('nothing exists after the dry run (404)', g0.status === 404, g0.status)
    const ap = await call('POST', '/api/v1/admin/imports/products', {
      body: { dryRun: false, rows },
    })
    check(
      'apply -> 3 APPLIED',
      ap.status === 200 &&
        ap.body.applied === 3 &&
        ap.body.results.every((r: any) => r.outcome === 'APPLIED'),
      ap.body,
    )
    for (const r of rows) {
      const g = await call('GET', `/api/v1/products/${r.id}`, { quiet: true })
      check(
        `product ${r.id} exists with its exact (case-preserved) id`,
        g.status === 200 && g.body.id === r.id && g.body.lifecycle === 'draft',
      )
    }
    const again = await call('POST', '/api/v1/admin/imports/products', {
      body: { dryRun: false, rows },
    })
    check(
      're-submitting the same file -> UNCHANGED, nothing re-written',
      again.status === 200 && again.body.applied === 0 && again.body.unchanged === 3,
      { applied: again.body.applied, unchanged: again.body.unchanged },
    )
    const clash = await call('POST', '/api/v1/admin/imports/products', {
      body: { dryRun: true, rows: [{ ...rows[0], title: 'different payload' }] },
    })
    check('same id with a different payload is refused as a conflict (422)', clash.status === 422, {
      status: clash.status,
      body: clash.body,
    })
  },
)

journey(
  'J06',
  'async import job end to end: create, upload CSV, validate, approve/apply, products exist',
  async () => {
    const want = ids(`TZP-Job-${RUN}-`, 12)
    const csv =
      [hdr, ...want.map((id, i) => csvRow(id, `Job product ${i}`, `jk-${RUN}-${i}`))].join('\r\n') +
      '\r\n'
    const j = await createJob(`J06 ${RUN}`)
    check('create job -> 201 OPEN', j.status === 201 && j.body.status === 'OPEN', j.body.status)
    const id = j.body.id
    const ap = await appendCsv(id, csv)
    check(
      'upload CSV (text/csv) -> 12 rows added',
      ap.status === 200 && ap.body.rowsAdded === 12 && ap.body.rowsTotal === 12,
      ap.body,
    )
    const v = await jobAction(id, 'validate')
    check(
      'validate -> VALIDATING',
      v.status === 200 && v.body.status === 'VALIDATING',
      v.body.status,
    )
    const validated = await waitJob(id, ['VALIDATED', 'REJECTED'])
    check(
      'worker reports VALIDATED with 12 valid',
      validated?.status === 'VALIDATED' && validated.counts.valid === 12,
      validated?.counts,
    )
    const early = await call('GET', `/api/v1/products/${want[0]}`, { quiet: true })
    check('validation wrote nothing (products still 404)', early.status === 404)
    const a = await jobAction(id, 'apply', validated.version)
    check(
      'apply (explicit approval) -> APPLYING',
      a.status === 200 && a.body.status === 'APPLYING' && Boolean(a.body.approvedBy),
      a.body.status,
    )
    const done = await waitJob(id, ['COMPLETED', 'PAUSED', 'FAILED'], 180_000)
    check(
      'job COMPLETED with applied=12 failed=0',
      done?.status === 'COMPLETED' && done.counts.applied === 12 && done.counts.failed === 0,
      done?.counts,
    )
    let missing = 0
    for (const p of want)
      if ((await call('GET', `/api/v1/products/${p}`, { quiet: true })).status !== 200) missing++
    check('all 12 products exist', missing === 0, { missing })
    const ec = await call('GET', `/api/v1/admin/imports/jobs/${id}/errors.csv`, {
      headers: { Accept: 'text/csv' },
    })
    check(
      'errors.csv of a clean job has no data lines',
      ec.status === 200 && ec.text.trim().split(/\r?\n/).length <= 1,
      ec.text.slice(0, 120),
    )
    const j2 = await createJob(`J06 rerun ${RUN}`)
    await appendCsv(j2.body.id, csv)
    await jobAction(j2.body.id, 'validate')
    const re = await waitJob(j2.body.id, ['VALIDATED', 'REJECTED'])
    check(
      're-uploading the same file validates every row as UNCHANGED',
      re?.counts?.unchanged === 12,
      re?.counts,
    )
    await jobAction(j2.body.id, 'cancel')
    S.set('j06', { want })
  },
)

journey(
  'J07',
  'async import with invalid rows: per-row verdicts, apply blocked, correct a row, errors.csv neutralises formulas',
  async () => {
    const good = `TZP-Fix-${RUN}-ok`
    const fixMe = `tzp-fix-${RUN}`
    const rowsCsv = [
      hdr,
      csvRow(good, 'Good row', `fk-ok-${RUN}`),
      csvRow(fixMe, 'Lowercase id to fix', `fk-low-${RUN}`),
      csvRow('=cmd|calc', 'Formula id', `fk-f1-${RUN}`),
      csvRow('+SUM(1)', 'Plus id', `fk-f2-${RUN}`),
      csvRow('@evil', 'At id', `fk-f3-${RUN}`),
      csvRow('-2+3', 'Minus id', `fk-f4-${RUN}`),
      csvRow(`TZP-Fix-${RUN}-dup`, 'Dup A', `fk-d-${RUN}`),
      csvRow(`TZP-Fix-${RUN}-dup`, 'Dup B', `fk-d2-${RUN}`),
    ].join('\n')
    const j = await createJob(`J07 ${RUN}`)
    const id = j.body.id
    await appendCsv(id, rowsCsv)
    await jobAction(id, 'validate')
    const rej = await waitJob(id, ['VALIDATED', 'REJECTED'])
    check('job REJECTED', rej?.status === 'REJECTED', rej?.status)
    check(
      'counts: 2 valid, 5 invalid, 1 duplicate',
      rej?.counts?.valid === 2 && rej?.counts?.invalid === 5 && rej?.counts?.duplicate === 1,
      rej?.counts,
    )
    const rows = await call('GET', `/api/v1/admin/imports/jobs/${id}/rows?from=0&limit=50`)
    const verdicts = (rows.body.rows as any[]).map((r) => `${r.row}:${r.validation?.outcome}`)
    check(
      'per-row verdicts are listed (VALID, INVALID, INVALID..., DUPLICATE)',
      verdicts[0] === '0:VALID' && verdicts[1] === '1:INVALID' && verdicts.at(-1) === '7:DUPLICATE',
      verdicts,
    )
    const ap = await jobAction(id, 'apply', rej.version)
    check(
      'apply of a REJECTED job is blocked (4xx) and writes nothing',
      ap.status >= 400 &&
        ap.status < 500 &&
        (await call('GET', `/api/v1/products/${good}`, { quiet: true })).status === 404,
      ap.status,
    )
    section('errors.csv with formula neutralisation (OWASP CSV injection)')
    const ec = await call('GET', `/api/v1/admin/imports/jobs/${id}/errors.csv`, {
      headers: { Accept: 'text/csv' },
    })
    const lines = ec.text.split(/\r?\n/).filter(Boolean)
    check(
      'errors.csv: text/csv and one line per negative row (+ header)',
      (ec.headers.get('content-type') ?? '').includes('csv') && lines.length === 1 + 6,
      { type: ec.headers.get('content-type'), lines: lines.length },
    )
    log(
      '  errors.csv body (redaction-free, synthetic data):\n' +
        ec.text
          .split('\n')
          .map((l) => '    ' + l)
          .join('\n'),
    )
    for (const [raw, label] of [
      ['=cmd|calc', '='],
      ['+SUM(1)', '+'],
      ['@evil', '@'],
      ['-2+3', '-'],
    ] as const) {
      const line = lines.find((l) => l.includes(raw))
      check(
        `errors.csv neutralises a cell starting with "${label}" (prefixed with ')`,
        Boolean(line) && line!.includes(`'${raw}`),
        line,
      )
    }
    section('correct the lowercase row and the other bad rows, re-validate, approve')
    const fixes: [number, string, string][] = [
      [1, `TZP-Fix-${RUN}-low`, `fk-low-${RUN}`],
      [2, `TZP-Fix-${RUN}-f1`, `fk-f1-${RUN}`],
      [3, `TZP-Fix-${RUN}-f2`, `fk-f2-${RUN}`],
      [4, `TZP-Fix-${RUN}-f3`, `fk-f3-${RUN}`],
      [5, `TZP-Fix-${RUN}-f4`, `fk-f4-${RUN}`],
      [7, `TZP-Fix-${RUN}-dup2`, `fk-d2-${RUN}`],
    ]
    for (const [row, newId, key] of fixes) {
      const r = await call('PUT', `/api/v1/admin/imports/jobs/${id}/rows/${row}`, {
        body: productBody(newId, `Corrected row ${row}`, { internalKey: key }),
      })
      check(`PUT rows/${row} correction accepted`, r.status === 200, r.status)
    }
    const reopened = await getJob(id)
    check(
      'job reopened to OPEN by the correction',
      reopened.body.status === 'OPEN',
      reopened.body.status,
    )
    await jobAction(id, 'validate')
    const ok = await waitJob(id, ['VALIDATED', 'REJECTED'])
    check(
      're-validation -> VALIDATED, 8 valid',
      ok?.status === 'VALIDATED' && ok.counts.valid === 8,
      ok?.counts,
    )
    const a = await jobAction(id, 'apply', ok.version)
    check('apply accepted', a.status === 200, a.status)
    const done = await waitJob(id, ['COMPLETED', 'PAUSED'], 120_000)
    check(
      'COMPLETED applied=8',
      done?.status === 'COMPLETED' && done.counts.applied === 8,
      done?.counts,
    )
    check(
      'the corrected product exists under its new id and the bad id does not',
      (await call('GET', `/api/v1/products/TZP-Fix-${RUN}-low`, { quiet: true })).status === 200 &&
        (await call('GET', `/api/v1/products/${fixMe}`, { quiet: true })).status === 404,
    )
  },
)

journey(
  'J08',
  'import resume: worker crash mid-apply (kill -9 + restart), lease takeover, no re-apply; datastore outage ridden out',
  async () => {
    const n = 400
    const want = ids(`TZP-Res-${RUN}-`, n)
    const csv = [
      hdr,
      ...want.map((id, i) => csvRow(id, `Resume product ${i}`, `rk-${RUN}-${i}`)),
    ].join('\n')
    const j = await createJob(`J08 ${RUN}`)
    const id = j.body.id
    await appendCsv(id, csv)
    await jobAction(id, 'validate')
    const v = await waitJob(id, ['VALIDATED'])
    if (v?.status !== 'VALIDATED') blocked(`setup: job did not validate (${v?.status})`)
    await jobAction(id, 'apply', v.version)
    let part: any = null
    for (let i = 0; i < 600; i++) {
      part = (await getJob(id)).body
      if (part.counts.applied >= 15 || part.status !== 'APPLYING') break
      await sleep(50)
    }
    log(`  part-way: status=${part.status} applied=${part.counts.applied}/${n}`)
    if (part.status !== 'APPLYING')
      blocked(
        `apply finished (${part.status}) before a crash could be injected; the job was too small for this host`,
      )
    // PAUSED needs the worker to observe a datastore failure and record it. A datastore outage did not produce it (see below), so the
    // resume scenario is the next-best real one: the whole backend process dies mid-apply (SIGKILL) and is started again.
    const pid = Number(
      readFileSync(join(process.env.E2E_RUN_DIR!, 'pids', 'backend.pid'), 'utf8').trim(),
    )
    process.kill(pid, 'SIGKILL')
    log(`  SIGKILL sent to the backend (pid ${pid}) with ${part.counts.applied} rows applied`)
    await sleep(2000)
    const t0 = Date.now()
    const up = sh(join(process.env.E2E_HARNESS_DIR!, 'scripts/up.sh'), [])
    check(
      'backend restarted by scripts/up.sh and ready',
      up.code === 0 && up.out.includes('backend ready'),
      up.out.slice(-200),
    )
    let st: any = (await getJob(id)).body
    const stalled = st.counts.applied
    log(`  after restart: status=${st.status} applied=${st.counts.applied}`)
    const early = await jobAction(id, 'resume', st.version)
    check(
      'POST /resume on a job that is not PAUSED is refused (409/4xx)',
      early.status >= 400 && early.status < 500,
      early.status,
    )
    st = await waitJob(id, ['COMPLETED', 'PAUSED', 'FAILED'], 240_000)
    if (st?.status === 'PAUSED') {
      const r = await jobAction(id, 'resume', st.version)
      check('POST /resume accepted for the PAUSED job', r.status === 200, r.status)
      st = await waitJob(id, ['COMPLETED', 'PAUSED', 'FAILED'], 180_000)
    }
    log(
      `  resumed by lease takeover ${Math.round((Date.now() - t0) / 1000)} s after the restart began (lease 60 s in this harness; 300 s default)`,
    )
    check(
      `COMPLETED with all ${n} rows applied or UNCHANGED, none FAILED (resumed from the cursor, not restarted)`,
      st?.status === 'COMPLETED' &&
        st.counts.applied + st.counts.unchanged === n &&
        st.counts.failed === 0,
      st?.counts,
    )
    check(
      'the rows applied before the crash were not applied twice (applied+unchanged == rows)',
      st.counts.applied + st.counts.unchanged === n && stalled <= n,
      { appliedBeforeRestart: stalled },
    )
    const out = sh('docker', [
      'exec',
      'tazzzo-e2e-mongo',
      'mongosh',
      '--quiet',
      '--port',
      process.env.E2E_MONGO_PORT!,
      'tazzzo_e2e',
      '--eval',
      `db.products.countDocuments({_id: /^TZP-Res-${RUN}-/})`,
    ])
    check(
      `exactly ${n} products exist (nothing minted twice, nothing lost)`,
      out.out.trim() === String(n),
      out.out.trim(),
    )

    section(
      'datastore outage during an apply: does the worker pause? (honest probe of the PAUSED path)',
    )
    const m = 300
    const j2 = await createJob(`J08b ${RUN}`)
    await appendCsv(
      j2.body.id,
      [
        hdr,
        ...ids(`TZP-Out-${RUN}-`, m).map((x, i) =>
          csvRow(x, `Outage product ${i}`, `ok-${RUN}-${i}`),
        ),
      ].join('\n'),
    )
    await jobAction(j2.body.id, 'validate')
    const v2 = await waitJob(j2.body.id, ['VALIDATED'])
    await jobAction(j2.body.id, 'apply', v2.version)
    for (let i = 0; i < 600; i++) {
      part = (await getJob(j2.body.id)).body
      if (part.counts.applied >= 10 || part.status !== 'APPLYING') break
      await sleep(50)
    }
    if (part.status === 'APPLYING') {
      const outage = Number(process.env.E2E_OUTAGE_SECONDS || 40)
      docker('stop', '-t', '1', 'tazzzo-e2e-mongo')
      await sleep(outage * 1000)
      docker('start', 'tazzzo-e2e-mongo')
      for (let i = 0; i < 60; i++) {
        const h = sh('docker', [
          'exec',
          'tazzzo-e2e-mongo',
          'mongosh',
          '--quiet',
          '--port',
          process.env.E2E_MONGO_PORT!,
          '--eval',
          'db.hello().isWritablePrimary',
        ])
        if (h.out.trim() === 'true') break
        await sleep(1000)
      }
      let s2: any = null
      for (let i = 0; i < 100; i++) {
        s2 = (await getJob(j2.body.id)).body
        if (['PAUSED', 'COMPLETED', 'FAILED'].includes(s2?.status)) break
        await sleep(2000)
      }
      log(
        `  after a ${outage} s datastore outage: status=${s2?.status} lastError=${s2?.lastError} counts=${JSON.stringify(s2?.counts)}`,
      )
      if (s2?.status === 'PAUSED') {
        const r = await jobAction(j2.body.id, 'resume', s2.version)
        s2 = await waitJob(j2.body.id, ['COMPLETED'], 180_000)
        check(
          'PAUSED by the outage, resumed with POST /resume, COMPLETED',
          r.status === 200 && s2?.status === 'COMPLETED',
          s2?.status,
        )
      } else {
        log(
          '  PAUSED was NOT produced: the worker/driver retried through the outage and the job completed by itself. POST /resume after PAUSED could not be exercised this way.',
        )
        check(
          'after the datastore outage the job still ends COMPLETED with nothing lost or duplicated',
          s2?.status === 'COMPLETED' &&
            s2.counts.applied + s2.counts.unchanged === m &&
            s2.counts.failed === 0,
          s2?.counts,
        )
      }
    }
  },
)

journey(
  'J09',
  'import cancel: before apply (nothing written) and while applying (stops, rest not written)',
  async () => {
    const mk = (p: string, n: number) =>
      [hdr, ...ids(p, n).map((id, i) => csvRow(id, `Cancel ${i}`, `${p}k${i}`))].join('\n')
    const a = await createJob(`J09a ${RUN}`)
    await appendCsv(a.body.id, mk(`TZP-CnA-${RUN}-`, 5))
    await jobAction(a.body.id, 'validate')
    const va = await waitJob(a.body.id, ['VALIDATED'])
    const ca = await jobAction(a.body.id, 'cancel')
    check(
      'cancel a VALIDATED job -> CANCELLED',
      ca.status === 200 && ca.body.status === 'CANCELLED',
      ca.body.status,
    )
    const ap = await jobAction(a.body.id, 'apply', va?.version)
    check('apply after cancel is refused (409/4xx)', ap.status >= 400 && ap.status < 500, ap.status)
    check(
      'no product was created',
      (await call('GET', `/api/v1/products/TZP-CnA-${RUN}-000`, { quiet: true })).status === 404,
    )
    const n = 120
    const b = await createJob(`J09b ${RUN}`)
    await appendCsv(b.body.id, mk(`TZP-CnB-${RUN}-`, n))
    await jobAction(b.body.id, 'validate')
    const vb = await waitJob(b.body.id, ['VALIDATED'])
    await jobAction(b.body.id, 'apply', vb?.version)
    let part: any = null
    for (let i = 0; i < 300; i++) {
      part = (await getJob(b.body.id)).body
      if (part.counts.applied >= 3 || part.status !== 'APPLYING') break
      await sleep(80)
    }
    const cb = await jobAction(b.body.id, 'cancel')
    log(
      `  cancel while ${part.status} applied=${part.counts.applied}: ${cb.status} ${cb.body?.status}`,
    )
    if (part.status !== 'APPLYING') blocked('job finished before it could be cancelled mid-apply')
    check(
      'cancel while APPLYING -> CANCELLED',
      cb.status === 200 && cb.body.status === 'CANCELLED',
      cb.body?.status,
    )
    await sleep(3000)
    const fin = (await getJob(b.body.id)).body
    check(
      'status stays CANCELLED and fewer than all rows were applied',
      fin.status === 'CANCELLED' && fin.counts.applied < n,
      fin.counts,
    )
    const out = sh('docker', [
      'exec',
      'tazzzo-e2e-mongo',
      'mongosh',
      '--quiet',
      '--port',
      process.env.E2E_MONGO_PORT!,
      'tazzzo_e2e',
      '--eval',
      `db.products.countDocuments({_id: /^TZP-CnB-${RUN}-/})`,
    ])
    check(
      'products in the datastore equal what the job recorded as applied (+/- the one row in flight)',
      Math.abs(Number(out.out.trim()) - fin.counts.applied) <= 1,
      { products: out.out.trim(), applied: fin.counts.applied },
    )
  },
)

journey(
  'J10',
  'errors.csv download: complete stream, header, row order, content type, auth',
  async () => {
    const j = await createJob(`J10 ${RUN}`)
    const rows = [
      hdr,
      ...Array.from({ length: 30 }, (_, i) =>
        i % 3 === 0
          ? csvRow(`bad id ${i}`, `Bad ${i}`, `ek${i}`)
          : csvRow(`TZP-Err-${RUN}-${i}`, `Ok ${i}`, `ek${i}`),
      ),
    ].join('\n')
    await appendCsv(j.body.id, rows)
    await jobAction(j.body.id, 'validate')
    const rej = await waitJob(j.body.id, ['REJECTED'])
    const ec = await call('GET', `/api/v1/admin/imports/jobs/${j.body.id}/errors.csv`, {
      headers: { Accept: 'text/csv' },
    })
    const lines = ec.text.split(/\r?\n/).filter(Boolean)
    check(
      '200 text/csv attachment',
      ec.status === 200 && (ec.headers.get('content-type') ?? '').includes('text/csv'),
      { type: ec.headers.get('content-type'), disposition: ec.headers.get('content-disposition') },
    )
    check(
      `one data line per invalid row (${rej?.counts?.invalid}) after a header`,
      lines.length - 1 === rej?.counts?.invalid && lines.length === 11,
      lines.length,
    )
    const rowNums = lines.slice(1).map((l) => Number(l.split(',')[0]))
    check(
      'rows are in strictly ascending order',
      rowNums.every((x, i) => i === 0 || x > rowNums[i - 1]!),
      rowNums,
    )
    log('  header: ' + lines[0])
    check(
      'reader may download it (GET is a read)',
      (
        await call('GET', `/api/v1/admin/imports/jobs/${j.body.id}/errors.csv`, {
          role: 'reader',
          quiet: true,
          headers: { Accept: 'text/csv' },
        })
      ).status === 200,
    )
    check(
      'anonymous may not (401)',
      (
        await call('GET', `/api/v1/admin/imports/jobs/${j.body.id}/errors.csv`, {
          role: 'anonymous',
          quiet: true,
          headers: { Accept: 'text/csv' },
        })
      ).status === 401,
    )
    await jobAction(j.body.id, 'cancel')
  },
)
