const core = require("@actions/core");
const AWS = require("aws-sdk");
const path = require('path');
const fs = require('fs');

const ecs = new AWS.ECS();
// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy'
];

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(`Ignoring property '${attribute}' in the task definition file. ` +
        'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
        'but it is not a valid field when registering a new task definition. ' +
        'This field can be safely removed from your task definition file.');
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

function maintainValidObjects(taskDef) {
  if (validateProxyConfigurations(taskDef)) {
    taskDef.proxyConfiguration.properties.forEach((property, index, arr) => {
      if (!('value' in property)) {
        arr[index].value = '';
      }
      if (!('name' in property)) {
        arr[index].name = '';
      }
    });
  }

  if(taskDef && taskDef.containerDefinitions){
    taskDef.containerDefinitions.forEach((container) => {
      if(container.environment){
        container.environment.forEach((property, index, arr) => {
          if (!('value' in property)) {
            arr[index].value = '';
          }
        });
      }
    });
  }
  return taskDef;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function validateProxyConfigurations(taskDef){
  return 'proxyConfiguration' in taskDef && taskDef.proxyConfiguration.type && taskDef.proxyConfiguration.type == 'APPMESH' && taskDef.proxyConfiguration.properties && taskDef.proxyConfiguration.properties.length > 0;
}

const main = async () => {
  const cluster = core.getInput("cluster", { required: true });
  const taskDefinitionFile = core.getInput("task-definition", { required: true });
  const service = core.getInput('service', { required: true });
  const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
        taskDefinitionFile :
        path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
  const fileContents = fs.readFileSync(taskDefPath, 'utf8');
  const taskDefContents = maintainValidObjects(removeIgnoredAttributes(cleanNullKeys(JSON.parse(fileContents))));

  let registerResponse;
  try {
    registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
  } catch (error) {
    core.setFailed("Failed to register task definition in ECS: " + error.message);
    core.debug("Task definition contents:");
    core.debug(JSON.stringify(taskDefContents, undefined, 4));
    throw(error);
  }
  const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
  core.setOutput('task-definition-arn', taskDefArn);


  let networkConfiguration;
  try {
    // Get network configuration from aws directly from describe services
    core.debug("Getting information from service...");
    const info = await ecs.describeServices({ cluster, services: [service] }).promise();

    if (!info || !info.services[0]) {
      throw new Error(`Could not find service ${service} in cluster ${cluster}`);
    }

    if (!info.services[0].networkConfiguration) {
      throw new Error(`Service ${service} in cluster ${cluster} does not have a network configuration`);
    }

    networkConfiguration = info.services[0].networkConfiguration;
  } catch (error) {
    core.setFailed(error.message);
    throw(error)
  }

  const overrideContainer = core.getInput("override-container", {
    required: false,
  });
  const overrideContainerCommand = core.getMultilineInput(
      "override-container-command",
      {
        required: false,
      }
  );

  const taskParams = {
    taskDefinition : taskDefArn,
    cluster,
    count: 1,
    launchType: "FARGATE",
    networkConfiguration,
  };

  try {
    if (overrideContainerCommand.length > 0 && !overrideContainer) {
      throw new Error(
          "override-container is required when override-container-command is set"
      );
    }

    if (overrideContainer) {
      if (overrideContainerCommand) {
        taskParams.overrides = {
          containerOverrides: [
              {
                name: overrideContainer,
                command: overrideContainerCommand,
              },
          ],
        };
      } else {
        throw new Error(
            "override-container-command is required when override-container is set"
        );
      }
    }

    core.debug("Running task...");
    let task = await ecs.runTask(taskParams).promise();
    const taskArn = task.tasks[0].taskArn;
    core.setOutput("task-arn", taskArn);
    let started = false;
    start = new Date();
    core.info(`Waiting for task to start ${cluster}:${taskArn}`);
    while(!started) {
      await wait(10000);
      try {
        await ecs.waitFor("tasksRunning", { cluster, tasks: [taskArn] }).promise();
        started = true;
      } catch(error) {
        core.debug(`${cluster}:${taskArn} Failed to get started data ${error.message}`);
        let now = new Date();
        if((now - start) > 300000) {
          throw new Error('Timed out waiting for the container to start');
        }
      }

    }
    core.info(`Waiting for task to finish ${cluster}:${taskArn}`);
    await ecs.waitFor("tasksStopped", { cluster, tasks: [taskArn] }).promise();

    core.debug("Checking status of task");
    task = await ecs.describeTasks({ cluster, tasks: [taskArn] }).promise();
    const exitCode = task.tasks[0].containers[0].exitCode;

    if (exitCode === 0) {
      core.setOutput("status", "success");
    } else {
      core.setFailed(`non-zero exit code: ${task.tasks[0].stoppedReason}`);

      const taskHash = taskArn.split("/").pop();
      core.info(
          `task failed, you can check the error on Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${AWS.config.region}#/clusters/${cluster}/tasks/${taskHash}/details`
      );
    }
  } catch (error) {
    core.setFailed(error.message);
  }
};

main();
