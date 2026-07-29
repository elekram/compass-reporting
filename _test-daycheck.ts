import { attendanceGetPeriodLinesBetweenBounds } from './api/compass-api.ts'

const lines: any[] = []
await attendanceGetPeriodLinesBetweenBounds(
  '2026-03-23',
  '2026-03-24',
  '2023-08-01T05:46:30Z',
  async (page) => { lines.push(...page) },
)

console.log(`live Compass returned ${lines.length} period lines for 2026-03-23`)

const targetIds = new Set([
  '2a2a36d1-7810-486d-88a2-972272f699bc',
  '15653866-ef34-4a6a-9ff4-3562d566d718',
  'f7156db0-2f8a-44e0-bf36-dc7e4281782b',
  '6c727e1b-3d30-48d8-8955-6f60cef5a1ce',
  'a21e8ac8-ab03-4bc0-8650-4014feb2a6b4',
  '158cddc5-aed5-4288-978c-8607baed4003',
  'ba059a7f-7309-4662-832e-1e4ee57bd76e',
  '3128af44-f573-45f6-bec8-17f0b9b5a18f',
])

const found = lines.filter(l => targetIds.has(l.compassPersonId))
console.log(`of those, ${found.length} still present live in Compass`)
for (const f of found) console.log(f.periodLineId, f.compassPersonId, f.updatedTimestamp)
