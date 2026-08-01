export type AbsenceCategory = 'unexplained' | 'explained'

// claude: one definition = one report a coordinator/team can be sent. New reports
// claude: (a different year level, a different team) are added by dropping another
// claude: file in reports/ and registering it — never by branching existing code.
export interface ReportDefinition {
  id: string
  title: string
  category: AbsenceCategory
  // claude: undefined = all year levels. Values match StudentBasic.yearLevel
  // claude: (e.g. "7", "12"), not display labels.
  yearLevels?: string[]
  // claude: row-inclusion cutoff on attendance %, same band edge used for the bar
  // claude: colour (green/orange/red) in the email template. Defaults to 85.
  threshold?: number
  // claude: default recipients for this report; send-report.ts's CLI arg overrides.
  recipients?: string[]
}
