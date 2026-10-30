export async function loadPagedRows(client, table, { columns = '*', orders = [], filters = [] } = {}) {
  const rows = []
  for (let offset = 0; ; offset += 500) {
    let request = client.from(table).select(columns)
    for (const [column, options] of orders) request = request.order(column, options)
    for (const [column, value] of filters) request = request.eq(column, value)
    const { data, error } = await request.range(offset, offset + 499)
    if (error) return { data: null, error }
    if (!Array.isArray(data)) return { data: null, error: new Error(`Could not load ${table}. Please retry.`) }
    rows.push(...data)
    if (data.length < 500) return { data: rows, error: null }
  }
}
