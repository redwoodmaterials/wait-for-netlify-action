const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');

const READY_STATES = ['ready', 'current'];

function getNetlifyUrl(url) {
  return axios.get(url, {
    headers: {
      Authorization: `Bearer ${process.env.NETLIFY_TOKEN}`,
    },
  });
}

const waitForDeployCreation = async (url, commitSha, timeoutSeconds, context) => {
  const startTime = Date.now();
  const retrySeconds = 5;

  return checkContinually();

  async function checkContinually() {
    const currentDeployment = await getCurrentDeploymentIfCreated();
    if (currentDeployment) {
      console.log(`Deployment created (${ellapsedSeconds(startTime)}s)`);
      return currentDeployment;
    }

    // Timeout
    if (ellapsedSeconds() > timeoutSeconds) {
      throw new Error(
        `Timeout reached: Deployment was not ready within ${timeoutSeconds} seconds.`
      );
    }

    // Retry
    console.log(`Deploy not yet created. Trying again in ${retrySeconds} seconds...`);
    await waitForSeconds(retrySeconds);
    return checkContinually();
  }

  async function getCurrentDeploymentIfCreated() {
    // Get list of all deployments
    const { data: netlifyDeployments } = await getNetlifyUrl(url);
    if (!netlifyDeployments) {
      throw new Error(`Failed to get deployments for site`);
    }
    // Attempt to find current deployment
    return netlifyDeployments.find(
      (d) => d.commit_ref === commitSha && (!context || d.context === context)
    );
  }
};

const waitForReadiness = (url, timeoutSeconds) => {
  const startTime = Date.now();
  const retrySeconds = 10;
  let latestDeployState = '(unknown)';

  return checkContinually();

  async function checkContinually() {
    const isReady = await isCurrentDeploymentReady();
    if (isReady) {
      console.log(`Deployment ready (${ellapsedSeconds(startTime)}s)`);
      return;
    }

    // Timeout
    if (ellapsedSeconds() > timeoutSeconds) {
      throw new Error(
        `Timeout reached: Deployment was not ready within ${timeoutSeconds} seconds. Last known deployment state: ${latestDeployState}.`
      );
    }

    // Retry
    console.log(
      `Deploy not yet ready (state = ${latestDeployState}). Trying again in ${retrySeconds} seconds...`
    );
    await waitForSeconds(retrySeconds);
    return checkContinually();
  }

  async function isCurrentDeploymentReady() {
    const { data: deploy } = await getNetlifyUrl(url);
    latestDeployState = deploy.state;
    return READY_STATES.includes(latestDeployState);
  }
};

const waitForUrl = async (url, timeoutSeconds) => {
  const iterations = timeoutSeconds / 3;
  for (let i = 0; i < iterations; i++) {
    try {
      await axios.head(url);
      return;
    } catch (e) {
      console.log(`URL ${url} unavailable, retrying...\n\t`, {
        errorCode: e && e.code,
        errorMessage: e && e.message,
      });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  core.setFailed(`Timeout reached: Unable to connect to ${url}`);
};

const run = async () => {
  try {
    const netlifyToken = process.env.NETLIFY_TOKEN;
    const commitSha =
      github.context.eventName === 'pull_request'
        ? github.context.payload.pull_request.head.sha
        : github.context.sha;
    const MAX_CREATE_TIMEOUT = 60 * 5; // 5 min
    const MAX_WAIT_TIMEOUT = 60 * 15; // 15 min
    const MAX_READY_TIMEOUT = Number(core.getInput('max_timeout')) || 60;
    const siteId = core.getInput('site_id');
    const context = core.getInput('context');

    if (!netlifyToken) {
      core.setFailed(
        'Please set NETLIFY_TOKEN env variable to your Netlify Personal Access Token secret'
      );
    }
    if (!commitSha) {
      core.setFailed('Could not determine GitHub commit');
    }
    if (!siteId) {
      core.setFailed('Required field `site_id` was not provided');
    }

    let message = `Waiting for Netlify to create a deployment for git SHA ${commitSha}`;

    if (context) {
      message += ` and context ${context}`;
    }

    console.log(message);
    const commitDeployment = await waitForDeployCreation(
      `https://api.netlify.com/api/v1/sites/${siteId}/deploys`,
      commitSha,
      MAX_CREATE_TIMEOUT,
      context
    );

    const url = `https://${commitDeployment.id}--${commitDeployment.name}.netlify.app`;

    core.setOutput('deploy_id', commitDeployment.id);
    core.setOutput('url', url);

    console.log(
      `Waiting for Netlify deployment ${commitDeployment.id} in site ${commitDeployment.name} to be ready`
    );
    await waitForReadiness(
      `https://api.netlify.com/api/v1/sites/${siteId}/deploys/${commitDeployment.id}`,
      MAX_WAIT_TIMEOUT
    );

    console.log(`Waiting for a 200 from: ${url}`);
    await waitForUrl(url, MAX_READY_TIMEOUT);
  } catch (error) {
    core.setFailed(typeof error === 'string' ? error : error.message);
  }
};

run();

//
// Utils
//

function ellapsedSeconds(timestamp) {
  const seconds = (Date.now() - timestamp) / 1000;
  return Math.round(seconds * 10) / 10;
}

function waitForSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
