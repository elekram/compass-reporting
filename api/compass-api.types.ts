// API/compass-api.types.ts

// Based on the GetPeriodLines request, but the response will have more fields.
// You'll need to fill this out based on the actual API response.
// claude: unverified for attendanceGetPeriodLines / attendanceGetLines / makeRequest —
// claude: still in use by those functions. See PeriodAttendanceLine below for the shape
// claude: confirmed against the real GetPeriodLinesTracking response.
export interface AttendancePeriodLine {
  arrivalTimestamp: string
  campusGuid: string
  compassPersonId: string
  countedAbsenceMinutes: number
  departureTimestamp: string
  description: string | null
  expectedMinutes: number
  finish: string
  nonCountedAbsenceMinutes: number
  'prevalentCountedAbsenceStatusId ': string | null
  prevalentNonCountedAbsenceStatusId: string | null
  prevalentOverallStatusId: string
  'schoolArrivalGapMinutes ': number
  'schoolDepartureGapMinutes ': number
  sliceCode: string | null
  start: string
  unmarkedMinutes: number
  unscheduledMinutes: number
  updatedTimestamp: string
}

export interface AttendancePeriodLineDateObject {
  arrivalTimestamp: Date
  campusGuid: string
  compassPersonId: string
  countedAbsenceMinutes: number
  departureTimestamp: Date
  description: string | null
  expectedMinutes: number
  finish: Date
  nonCountedAbsenceMinutes: number
  'prevalentCountedAbsenceStatusId ': string | null
  prevalentNonCountedAbsenceStatusId: string | null
  prevalentOverallStatusId: string
  'schoolArrivalGapMinutes ': number
  'schoolDepartureGapMinutes ': number
  sliceCode: string | null
  start: Date
  unmarkedMinutes: number
  unscheduledMinutes: number
  updatedTimestamp: Date
}

// A map where the key is a date string (e.g., "2026-02-01")
// and the value is an array of attendance lines for that day.
export type GroupedAttendance = Map<string, AttendancePeriodLineDateObject[]>

// claude: based on the actual response from attendanceGetPeriodLinesBetweenBounds
// claude: (V4/Attendance/GetPeriodLinesTracking), see models/attendanceGetPeriodLinesBetweenBounds.json
export interface PeriodAttendanceLine {
  __type: string
  campusGuid: string | null
  compassPersonId: string
  description: string | null
  expectedMinutes: number
  finish: string
  periodCode: string
  periodLineId: string
  prevalentOverallStatusId: string
  standardClassShadow: boolean | null
  start: string
  teachingTime: boolean
  updatedTimestamp: string
}

// Based on the GetStatuses response
// claude: old guessed version — kept as reference, commented out, superseded below
// export interface AttendanceStatus {
//   id: number
//   name: string
//   shortName: string
//   isSystemStatus: boolean
// }

// claude: based on the actual response from attendanceGetStatuses (api/attendance/v3/GetStatuses),
// claude: see models/attendanceGetStatuses.json
export interface AttendanceStatus {
  __type: string
  countedAbsence: boolean
  description: string
  name: string
  parentSelectable: boolean
  schoolSystemExportIdentifier: string
  shortCode: string
  shortName: string
  staffSelectable: boolean
  statusId: string
}

// Based on the GetChronicleEntries response
export interface ChronicleEntry {
  id: number
  userId: number
  subject: string
  entry: string
  timestamp: string
}

// Based on the GetFormGroups response
export interface FormGroup {
  id: number
  name: string
  description: string
}

// Based on the GetStudents response
// claude: old guessed version — kept as reference, commented out, superseded below
// export interface Student {
//   id: number
//   userId: number
//   firstName: string
//   lastName: string
//   schoolYear: number
// }

// claude: based on the actual response from personGetStudents (API/V6/Person/GetStudents),
// claude: see models/personGetStudents.json. The real __type is "Person" (a full contact
// claude: record, not just a student). Fields that came back as unexpanded "[Object]" in
// claude: the console output (addresses, emergencyContacts, identifications,
// claude: importIdentifiers, languages, organisationMilestones, studentDetails — which is
// claude: where schoolYear likely lives) are omitted since their shape isn't visible yet.
export interface Student {
  __type: string
  accessRestrictions: unknown[]
  adultToStudentRelationships: unknown[]
  ambulanceSubscriber: boolean
  arrivalDate: string | null
  authenticationMode: string
  birthCountry: string
  birthCountryCode: string
  communicationPreference: string
  compassPersonId: string
  contactNotesAh: string | null
  contactNotesBh: string | null
  contactable: boolean
  customFields: unknown[]
  dateOfBirth: string
  dateOfDeath: string | null
  disability: boolean
  disabilityFunded: boolean
  doctors: unknown[]
  emailAddress: string
  emailAllowed: boolean
  employer: string | null
  firstName: string
  formerFirstName: string | null
  formerLastName: string | null
  gender: string
  genderCode: string
  globalStudentDetails: {
    __type: string
    feeMode: string
    programCode: string | null
  }
  governmentFunded: boolean
  govtCode1: string
  govtCode2: string
  headLiceCheckAllowed: boolean
  homePhoneNumber: string | null
  homeTown: string | null
  immunisationRecordDateReceived: string | null
  immunisationRecordSighted: boolean
  immunisationRecordStatus: string
  immunisations: unknown[]
  importMode: string
  indigenousType: string
  indigenousTypeCode: string
  interpreterRequired: boolean
  languageBackgroundOtherThanEnglish: boolean
  lastModified: string
  lastName: string
  livingArrangements: string
  medicalAttachments: unknown[]
  medicalConditions: unknown[]
  medicationConsents: unknown[]
  middleName: string
  mobileNumber: string
  nationality: string | null
  nationalityCode: string | null
  nonSchoolEducation: string | null
  nonSchoolEducationCode: string | null
  occupation: string | null
  occupationalGroup: string | null
  parentDetails: unknown[]
  parish: string | null
  preferredFirstName: string
  preferredLastName: string | null
  publishPhotoToInternal: boolean
  publishPhotoToMedia: boolean
  receivesEsl: boolean
  refugeeStatus: boolean
  religion: string
  religionCode: string | null
  religionNotes: string | null
  religiousMilestones: unknown[]
  religiousOrLay: string | null
  repeatOfYearIndicator: boolean
  requiresEsl: boolean
  residencyStatus: string
  rfidCard: string | null
  schoolEducation: string | null
  schoolEducationCode: string | null
  schoolHistory: unknown[]
  secondMiddleName: string
  shareEmailAndMobileInParentDirectory: boolean
  shcsCompletedDate: string | null
  shcsToBeShared: boolean
  shcsWhoToInform: string | null
  smsAllowed: boolean
  staffDetails: unknown[]
  swimmingProficiency: boolean
  title: string
  townOfBirth: string | null
  username: string
  usualTransport: string | null
  vehicles: unknown[]
  visaExpiryDate: string | null
  visaSubclassCode: string | null
  visaSubclassCodeString: string | null
  visaSubclassName: string | null
  youthAllowance: boolean
}

// claude: based on the actual response from getStudentsBasic
// claude: (api/person/v1/GetStudentsBasic) — a much lighter student record than the
// claude: full Person object above, and confirmed to have a better match rate
// claude: against attendance period lines. Preferred source for
// claude: assembleAttendanceReport's student join.
export interface StudentBasic {
  __type: string
  boarderType: string | null
  compassPersonId: string
  dateOfBirth: string
  emailAddress: string
  firstName: string
  gender: string
  getPersonPhotoUrl: string
  groupA: string | null
  groupB: string | null
  groupC: string | null
  groupD: string | null
  groupE: string | null
  homeCampus: string
  homePhoneNumber: string
  importIdentifiers: Array<{
    __type: string
    baseRole: number
    importIdentifier: string
    school: string
  }>
  lastName: string
  middleName: string
  mobileNumber: string
  nationality: string | null
  organisationName: string
  photoUploadDate: string | null
  preferredFirstName: string
  preferredLastName: string
  publishPhotoToInternal: boolean
  publishPhotoToMedia: boolean
  schoolEmail: string
  studentCode: string
  studentType: number
  title: string
  userStatus: number
  username: string
  yearLevel: string
}

// claude: flat, CSV-ready row combining a PeriodAttendanceLine with its matching
// claude: StudentBasic (joined on compassPersonId) and AttendanceStatus (joined on
// claude: prevalentOverallStatusId -> statusId). See assembleAttendanceReport
// claude: in compass-api.helpers.ts.
export interface AssembledAttendancePeriodLine
  extends Omit<PeriodAttendanceLine, '__type'> {
  firstName: string | null
  lastName: string | null
  preferredFirstName: string | null
  middleName: string | null
  username: string | null
  gender: string | null
  yearLevel: string | null
  studentCode: string | null
  statusName: string | null
  statusShortCode: string | null
  statusSchoolSystemExportIdentifier: string | null
  statusDescription: string | null
  countedAbsence: boolean | null
}

// claude: one row per student, aggregated from AssembledAttendancePeriodLine by
// claude: calculateAttendancePercentages in compass-api.helpers.ts. Only
// claude: teachingTime periods count toward expectedMinutes — see the conversation
// claude: on periodCode for why (non-teaching blocks like recess/lunch aren't real
// claude: instructional time and aren't tracked uniformly across students anyway).
// claude: unexplainedAbsenceMinutes only counts the "Unexplained"
// claude: (schoolSystemExportIdentifier "500") status; explainedAbsenceMinutes
// claude: counts only the curated REPORTABLE_STATUS_EXPORT_IDS reasons (excluding
// claude: 500) — the two are mutually exclusive and reported separately rather than
// claude: combined, since only unexplained absence is actionable.
// claude: the *Days fields count calendar dates rather than minutes: *DaysAny counts
// claude: a date if the student had at least one qualifying period that day,
// claude: *DaysFull only if every teaching period that day qualified.
// claude: statusGroupCounts is a period-line count (not collapsed to days) per
// claude: stakeholder-defined status group — see STATUS_GROUPS in
// claude: compass-api.helpers.ts for the schoolSystemExportIdentifier groupings and
// claude: display order.
export interface StudentAttendancePercentage {
  compassPersonId: string
  firstName: string | null
  lastName: string | null
  studentCode: string | null
  yearLevel: string | null
  expectedMinutes: number
  unexplainedAbsenceMinutes: number
  explainedAbsenceMinutes: number
  statusGroupCounts: number[]
  attendancePercentage: number | null
  explainedAttendancePercentage: number | null
  unexplainedDaysAny: number
  unexplainedDaysFull: number
  explainedDaysAny: number
  explainedDaysFull: number
}
