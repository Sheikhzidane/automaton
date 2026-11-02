import * as selfCheck from './self-check.mjs';
import * as publicHealth from './public-health.mjs';
import * as opsMetrics from './ops-metrics.mjs';
import * as fsaRefresh from './fsa-refresh.mjs';
import * as pipelineReview from './pipeline-review.mjs';
import * as revenueReview from './revenue-review.mjs';
import * as workReview from './work-review.mjs';
import * as dailyReport from './daily-report.mjs';

export const JOBS = {
  'self-check': selfCheck.run,
  'public-health': publicHealth.run,
  'ops-metrics': opsMetrics.run,
  'fsa-refresh': fsaRefresh.run,
  'pipeline-review': pipelineReview.run,
  'revenue-review': revenueReview.run,
  'work-review': workReview.run,
  'daily-report': dailyReport.run,
};
