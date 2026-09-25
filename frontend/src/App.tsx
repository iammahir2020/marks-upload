// step.md step 13.7 (plan.md §18) — a real screen enum replaces
// `config === null` as the router. Library is the new entry point;
// Section/Assessment forms create the durable things Scan/Results now
// read by reference (assessmentId) rather than by a single held config.
import { lazy, Suspense, useState } from 'react';
import AssessmentForm, { type NewAssessmentInput } from './AssessmentForm';
import { getAllAssessments, getAllSections, saveAssessment, saveSection } from './db';
import { showLandingOverlay } from './landingShell';
import Library from './Library';
import Scan from './Scan';
import { assessmentConfig, assessmentsForSection, defaultHasSerial } from './sections';
import SectionForm from './SectionForm';
import type { Assessment, Section } from './types';

// Lazy: ExcelJS is the bulk of Results' own weight (step.md step 9.4) and
// is only ever needed on this one, rarely-visited screen — splitting it
// out keeps it off the PWA's main precache, which the constantly-used
// Library/Scan/Review loop shouldn't have to pay for on first load.
const Results = lazy(() => import('./Results'));

type Screen = 'library' | 'section' | 'assessment' | 'scan' | 'results';

function App() {
  // Step.md 14.6 — the landing page is no longer a screen React ever
  // renders. The decision of whether a cold visit shows it lives entirely
  // in the static shell `scripts/prerender-landing.mjs` builds (a class
  // on <html>, set before this bundle even exists); by the time this
  // component mounts, the app's own first screen is always the library.
  const [screen, setScreen] = useState<Screen>('library');
  // null = creating a new section; a real Section = editing it in place.
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  // The section a new assessment is being created under, or the section
  // owning whichever assessment is currently active on Scan/Results.
  const [activeSection, setActiveSection] = useState<Section | null>(null);
  const [activeAssessment, setActiveAssessment] = useState<Assessment | null>(null);
  // Where SectionForm's Save/Cancel returns to: Library normally, but
  // Results' "Re-pick" (13.11) reopens the section's own edit screen for
  // its upload UI and must land back on Results, not bounce to the
  // library and lose the assessment that was open.
  const [sectionFormReturnsTo, setSectionFormReturnsTo] = useState<'library' | 'results'>('library');
  // Step.md 13.18 — set for exactly one Library mount, immediately after
  // creating (never editing) a section whose semester didn't exist among
  // any prior section. Library uses it to offer purging the OTHER
  // semesters once, then it's gone: every OTHER route back to Library
  // (toLibrary(), Cancel, "All sections") clears it, so the offer can
  // never resurface on a later, unrelated visit.
  const [pendingSemesterOffer, setPendingSemesterOffer] = useState<string | null>(null);
  // Step 16 — the new-assessment form's "Serial box on paper" starting
  // value, looked up from the section's own quizzes as the form opens.
  const [newAssessmentHasSerial, setNewAssessmentHasSerial] = useState(true);

  function toLibrary() {
    setPendingSemesterOffer(null);
    setScreen('library');
  }

  function returnFromSectionForm() {
    setPendingSemesterOffer(null);
    setScreen(sectionFormReturnsTo === 'results' ? 'results' : 'library');
  }

  if (screen === 'section') {
    return (
      <SectionForm
        editing={editingSection}
        onSave={async (section) => {
          // Read BEFORE saving — this is what "did this semester already
          // exist" has to compare against. Only a genuine creation
          // (never an edit) can introduce a "new" semester in the sense
          // 13.18 means; editing an existing section's semester field is
          // deliberately out of scope (see step.md's own note on why).
          const isNewSection = editingSection === null;
          const priorSections = isNewSection ? await getAllSections() : [];

          await saveSection(section);
          if (sectionFormReturnsTo === 'results') setActiveSection(section);

          const isNewSemester =
            isNewSection &&
            priorSections.length > 0 && // nothing to purge if this is the very first section ever
            !priorSections.some((s) => s.semester === section.semester);

          if (sectionFormReturnsTo === 'library' && isNewSemester) {
            setPendingSemesterOffer(section.semester);
            setScreen('library');
          } else {
            returnFromSectionForm();
          }
        }}
        onCancel={returnFromSectionForm}
      />
    );
  }

  if (screen === 'assessment' && activeSection) {
    return (
      <AssessmentForm
        section={activeSection}
        defaultHasSerial={newAssessmentHasSerial}
        onSave={async (input: NewAssessmentInput) => {
          const assessment: Assessment = {
            id: crypto.randomUUID(),
            sectionId: activeSection.id,
            ...input,
            createdAt: new Date().toISOString(),
            exportedAt: null,
          };
          await saveAssessment(assessment);
          setActiveAssessment(assessment);
          setScreen('scan');
        }}
        onCancel={toLibrary}
      />
    );
  }

  if (screen === 'scan' && activeSection && activeAssessment) {
    return (
      <Scan
        config={assessmentConfig(activeAssessment, activeSection)}
        assessmentId={activeAssessment.id}
        sectionLabel={`${activeSection.courseCode}-${activeSection.label}`}
        roster={activeSection.roster ?? null}
        onShowResults={() => setScreen('results')}
        onExit={toLibrary}
      />
    );
  }

  if (screen === 'results' && activeSection && activeAssessment) {
    return (
      <Suspense fallback={null}>
        <Results
          config={assessmentConfig(activeAssessment, activeSection)}
          assessmentId={activeAssessment.id}
          section={activeSection}
          assessment={activeAssessment}
          onAssessmentExported={(exportedAssessment) => setActiveAssessment(exportedAssessment)}
          onSectionUpdated={(updatedSection) => setActiveSection(updatedSection)}
          onEditSection={() => {
            setEditingSection(activeSection);
            setSectionFormReturnsTo('results');
            setScreen('section');
          }}
          onBack={() => setScreen('scan')}
          onLibrary={toLibrary}
        />
      </Suspense>
    );
  }

  return (
    <Library
      pendingSemesterOffer={pendingSemesterOffer}
      onShowLanding={showLandingOverlay}
      onNewSection={() => {
        setEditingSection(null);
        setSectionFormReturnsTo('library');
        setScreen('section');
      }}
      onEditSection={(section) => {
        setEditingSection(section);
        setSectionFormReturnsTo('library');
        setScreen('section');
      }}
      onNewAssessment={async (section) => {
        const all = await getAllAssessments();
        setNewAssessmentHasSerial(defaultHasSerial(assessmentsForSection(all, section.id)));
        setActiveSection(section);
        setScreen('assessment');
      }}
      onOpenAssessment={(section, assessment) => {
        setActiveSection(section);
        setActiveAssessment(assessment);
        setScreen('scan');
      }}
    />
  );
}

export default App;
