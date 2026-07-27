import postgres from 'postgres'

const dbUrl = Deno.env.get('DB_URL')
const sql = postgres(dbUrl)

export default sql
