import postgres from 'postgres'

const dbUrl = Deno.env.get('DB_URL')
if (!dbUrl) {
  throw new Error('no db url')
}

const sql = postgres(dbUrl)

export default sql
