import { ReportDefinition } from './types.ts'
import unexplainedAbsences from './unexplained-absences.ts'
import explainedAbsences from './explained-absences.ts'
import explainedAbsencesYear9 from './explained-absences-year-9.ts'
import explainedAbsencesYear12 from './explained-absences-year-12.ts'

// claude: every report must be registered here to be reachable by id from the CLI
// claude: scripts (send-report.ts, email-preview.ts, report.ts).
const reports: ReportDefinition[] = [
  unexplainedAbsences,
  explainedAbsences,
  explainedAbsencesYear9,
  explainedAbsencesYear12,
]

export function getReport(id: string): ReportDefinition {
  const report = reports.find((r) => r.id === id)
  if (!report) {
    const available = reports.map((r) => r.id).join(', ')
    throw new Error(`Unknown report id "${id}". Available: ${available}`)
  }
  return report
}

export default reports
