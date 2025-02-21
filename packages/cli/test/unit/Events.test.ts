import config from '@/config';
import { InternalHooksManager } from '../../src';
import { nodeFetchedData, workflowExecutionCompleted } from '../../src/events/WorkflowStatistics';
import { WorkflowExecuteMode } from 'n8n-workflow';

const FAKE_USER_ID = 'abcde-fghij';

const mockedFirstProductionWorkflowSuccess = jest.fn((...args) => {});
const mockedFirstWorkflowDataLoad = jest.fn((...args) => {});
const mockedError = jest.spyOn(console, 'error');

jest.spyOn(InternalHooksManager, 'getInstance').mockImplementation((...args) => {
	const actual = jest.requireActual('../../src/InternalHooks');
	return {
		...actual,
		onFirstProductionWorkflowSuccess: mockedFirstProductionWorkflowSuccess,
		onFirstWorkflowDataLoad: mockedFirstWorkflowDataLoad,
	};
});
jest.mock('../../src/Db', () => {
	return {
		collections: {
			Workflow: {
				update: jest.fn(({ id, dataLoaded }, updateArgs) => {
					if (id === 1) return { affected: 1 };
					return { affected: 0 };
				}),
			},
			WorkflowStatistics: {
				insert: jest.fn(({ count, name, workflowId }) => {
					if (workflowId === -1) throw new Error('test error');
					return null;
				}),
				update: jest.fn((...args) => {}),
			},
		},
	};
});
jest.mock('../../src/UserManagement/UserManagementHelper', () => {
	return {
		getWorkflowOwner: jest.fn((workflowId) => {
			return { id: FAKE_USER_ID };
		}),
	};
});

describe('Events', () => {
	beforeAll(() => {
		config.set('diagnostics.enabled', true);
		config.set('deployment.type', 'n8n-testing');
	});

	afterAll(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	beforeEach(() => {
		mockedFirstProductionWorkflowSuccess.mockClear();
		mockedFirstWorkflowDataLoad.mockClear();
		mockedError.mockClear();
	});

	afterEach(() => {});

	describe('workflowExecutionCompleted', () => {
		test('should fail with an invalid workflowId', async () => {
			const workflow = {
				id: 'abcde',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData = {
				finished: true,
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			await workflowExecutionCompleted(workflow, runData);
			expect(mockedError).toBeCalledTimes(1);
		});

		test('should create metrics for production successes', async () => {
			// Call the function with a production success result, ensure metrics hook gets called
			const workflow = {
				id: '1',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData = {
				finished: true,
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			await workflowExecutionCompleted(workflow, runData);
			expect(mockedFirstProductionWorkflowSuccess).toBeCalledTimes(1);
			expect(mockedFirstProductionWorkflowSuccess).toHaveBeenNthCalledWith(1, {
				user_id: FAKE_USER_ID,
				workflow_id: parseInt(workflow.id, 10),
			});
		});

		test('should only create metrics for production successes', async () => {
			// Call the function with a non production success result, ensure metrics hook is never called
			const workflow = {
				id: '1',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData = {
				finished: false,
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			await workflowExecutionCompleted(workflow, runData);
			expect(mockedFirstProductionWorkflowSuccess).toBeCalledTimes(0);
		});

		test('should not send metrics for updated entries', async () => {
			// Call the function with the id that causes insert to fail, ensure update is called *and* metrics aren't sent
			const mockedError = jest.spyOn(console, 'error');
			const workflow = {
				id: '-1',
				name: '',
				active: false,
				createdAt: new Date(),
				updatedAt: new Date(),
				nodes: [],
				connections: {},
			};
			const runData = {
				finished: true,
				data: { resultData: { runData: {} } },
				mode: 'internal' as WorkflowExecuteMode,
				startedAt: new Date(),
			};
			mockedError.mockClear();
			await workflowExecutionCompleted(workflow, runData);
			expect(mockedError).toBeCalled();
			expect(mockedFirstProductionWorkflowSuccess).toBeCalledTimes(0);
		});
	});

	describe('nodeFetchedData', () => {
		test('should fail with an invalid workflowId', async () => {
			const workflowId = 'abcde';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
			};
			await nodeFetchedData(workflowId, node);
			expect(mockedError).toBeCalledTimes(1);
		});

		test('should create metrics when the db is updated', async () => {
			// Call the function with a production success result, ensure metrics hook gets called
			const workflowId = '1';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
			};
			await nodeFetchedData(workflowId, node);
			expect(mockedFirstWorkflowDataLoad).toBeCalledTimes(1);
			expect(mockedFirstWorkflowDataLoad).toHaveBeenNthCalledWith(1, {
				user_id: FAKE_USER_ID,
				workflow_id: parseInt(workflowId, 10),
				node_type: node.type,
				node_id: node.id,
			});
		});

		test('should create metrics with credentials when the db is updated', async () => {
			// Call the function with a production success result, ensure metrics hook gets called
			const workflowId = '1';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
				credentials: {
					testCredentials: {
						id: '1',
						name: 'Test Credentials',
					},
				},
			};
			await nodeFetchedData(workflowId, node);
			expect(mockedFirstWorkflowDataLoad).toBeCalledTimes(1);
			expect(mockedFirstWorkflowDataLoad).toHaveBeenNthCalledWith(1, {
				user_id: FAKE_USER_ID,
				workflow_id: parseInt(workflowId, 10),
				node_type: node.type,
				node_id: node.id,
				credential_type: 'testCredentials',
				credential_id: node.credentials.testCredentials.id,
			});
		});

		test('should not send metrics for entries that already have the flag set', async () => {
			// Fetch data for workflow 2 which is set up to not be altered in the mocks
			const workflowId = '2';
			const node = {
				id: 'abcde',
				name: 'test node',
				typeVersion: 1,
				type: '',
				position: [0, 0] as [number, number],
				parameters: {},
			};
			await nodeFetchedData(workflowId, node);
			expect(mockedFirstWorkflowDataLoad).toBeCalledTimes(0);
		});
	});
});
