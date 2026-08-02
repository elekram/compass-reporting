import { ReportDefinition } from './types.ts'
import unexplainedAbsences from './unexplained-absences.ts'
import explainedAbsences from './explained-absences.ts'
import explainedAbsencesYear7 from './explained-absences-year-7.ts'
import explainedAbsencesYear8 from './explained-absences-year-8.ts'
import explainedAbsencesYear9 from './explained-absences-year-9.ts'
import explainedAbsencesYear10 from './explained-absences-year-10.ts'
import explainedAbsencesYear11 from './explained-absences-year-11.ts'
import explainedAbsencesYear12 from './explained-absences-year-12.ts'

// claude: every report must be registered here to be reachable by id from the CLI
// claude: scripts (send-report.ts, email-preview.ts, report.ts).
const reports: ReportDefinition[] = [
  unexplainedAbsences,
  explainedAbsences,
  explainedAbsencesYear7,
  explainedAbsencesYear8,
  explainedAbsencesYear9,
  explainedAbsencesYear10,
  explainedAbsencesYear11,
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
