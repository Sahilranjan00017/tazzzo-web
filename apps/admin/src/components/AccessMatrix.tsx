import { ACCESS_MATRIX, ACCESS_NOTES, MATRIX_ROLES } from '@/lib/roles'

/** Who can do what, per the backend. Columns for the viewer's own roles are marked. Display only. */
export function AccessMatrix({ yourRoles }: { yourRoles: readonly string[] }) {
  return (
    <section className="panel" aria-labelledby="matrix-h">
      <h2 id="matrix-h">What each role can do</h2>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Role access matrix">
        <table className="data-table">
          <caption className="sr-only">
            Backend access by role. R means read, R W means read and write, a dash means refused.
          </caption>
          <thead>
            <tr>
              <th scope="col">Area</th>
              {MATRIX_ROLES.map((r) => (
                <th key={r} scope="col">
                  <code>{r}</code>
                  {yourRoles.includes(r) ? <span className="you"> (you)</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ACCESS_MATRIX.map((row) => (
              <tr key={row.area}>
                <th scope="row">{row.area}</th>
                {MATRIX_ROLES.map((r) => (
                  <td key={r} className={yourRoles.includes(r) ? 'you-col' : undefined}>
                    {row.access[r] || <span aria-label="refused">–</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="muted">
        {ACCESS_NOTES.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <p className="muted">
        Product job titles (Catalog Manager, Pricing Manager and so on) are not backend roles;
        access is exactly these five roles. The backend authorizes every request regardless of what
        this page or the menus show.
      </p>
    </section>
  )
}
