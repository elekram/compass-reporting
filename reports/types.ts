export type AbsenceCategory = 'unexplained' | 'explained'

// one definition = one report a coordinator/team can be sent. New reports
// (a different year level, a different team) are added by dropping another
// file in reports/ and registering it — never by branching existing code.
export interface ReportDefinition {
  id: string
  title: string
  category: AbsenceCategory
  // undefined = all year levels. Values match StudentBasic.yearLevel
  // (e.g. "7", "12"), not display labels.
  yearLevels?: string[]
  // row-inclusion cutoff on attendance %, same band edge used for the bar
  // colour (green/orange/red) in the email template. Defaults to 85.
  threshold?: number
  // default recipients for this report; send-report.ts's CLI arg overrides.
  recipients?: string[]
  // opts into the extra "daily period breakdown" table rendered above the
  // per-student table — one row per student (in this report's category and
  // yearLevels scope) who had at least one flagged period on the most recent
  // complete school day, one column per teaching period. See
  // getDailyPeriodBreakdown in attendance-data.ts.
  dailyPeriodBreakdown?: boolean
}
