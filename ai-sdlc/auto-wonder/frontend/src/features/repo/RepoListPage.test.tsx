import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { RepoListPage } from './RepoListPage';
import { useAuthStore } from '@/shared/auth/store';
import { message } from 'antd';
import { copyTextToClipboard } from '@/shared/lib/clipboard';

vi.mock('@/shared/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }));

const copyMock = vi.mocked(copyTextToClipboard);

const httpUrl = 'https://github.com/Mike4Ellis/alibabacloud-landing-zone.git';
const sshUrl = 'git@gitlab.example.com:community/auto-wonder.git';
const longUrl = `https://git.example.com/group/${'a'.repeat(320)}.git`;

function repoRow(id: number, name: string, url: string) {
  return { id, name, url, defaultBranch: 'main', description: null, scanStatus: 'DONE', version: 1, gmtCreate: '2026-07-01' };
}

function mockRepoList(data: ReturnType<typeof repoRow>[]) {
  server.use(http.get('/api/repos', () => HttpResponse.json({
    success: true, code: '0', message: '', traceId: null, data,
  })));
}

function copyButton(name: string) {
  return screen.findByRole('button', { name: `复制仓库「${name}」的 Git 地址` });
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}{location.search || '(empty)'}</span>;
}

function renderPage(accessLevel: 'READ_ONLY' | 'READ_WRITE' = 'READ_WRITE') {
  useAuthStore.setState({ accessLevel });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><RepoListPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RepoListPage', () => {
  it('renders repo table and switches to the relation map tab in place', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/repos', () => {
        return HttpResponse.json({
          success: true, code: '0', message: '', traceId: null,
          data: [{ id: 1, name: 'auto-wonder', url: 'https://github.com/auto-wonder', defaultBranch: 'main', description: '主仓库', scanStatus: 'DONE', version: 1, gmtCreate: '2026-07-01' }],
        });
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/repos']}>
          <RepoListPage />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('auto-wonder')).toBeInTheDocument();
    const mapButton = screen.getByRole('button', { name: /关系图/ });
    await user.click(mapButton);
    // 关系图是 /repos hub 的兄弟 Tab：就地写 tab 参数，而不是跳转到独立路由。
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/repos?tab=map'));
  });

  it('creates repo from add repo modal', async () => {
    const user = userEvent.setup();
    let createdPayload: Record<string, unknown> | null = null;
    const sshRepoUrl = 'git@gitlab.example.com:community/auto-wonder.git';
    server.use(
      http.get('/api/repos', () => {
        return HttpResponse.json({
          success: true, code: '0', message: '', traceId: null,
          data: [],
        });
      }),
      http.post('/api/repos', async ({ request }) => {
        createdPayload = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          success: true, code: '0', message: '', traceId: null,
          data: {
            id: 2,
            name: 'new-repo',
            url: sshRepoUrl,
            defaultBranch: 'main',
            description: '新仓库',
            scanStatus: 'UNSCANNED',
            version: 0,
            gmtCreate: '2026-07-11',
          },
        });
      }),
    );

    renderPage();

    await user.click(screen.getByRole('button', { name: /添加仓库/ }));
    await user.type(screen.getByLabelText('仓库名称'), 'new-repo');
    await user.type(screen.getByLabelText('仓库地址'), sshRepoUrl);
    await user.type(screen.getByLabelText('默认分支'), 'main');
    await user.click(screen.getByRole('button', { name: '确 定' }));

    await waitFor(() => expect(createdPayload).toEqual({
      name: 'new-repo',
      url: sshRepoUrl,
      defaultBranch: 'main',
    }));
  });

  it('omits credential guidance and auth inputs from add repo modal', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/repos', () => HttpResponse.json({
        success: true, code: '0', message: '', traceId: null, data: [],
      })),
    );

    renderPage();

    await user.click(screen.getByRole('button', { name: /添加仓库/ }));
    expect(screen.queryByText(/推荐使用仓库级 SSH Deploy Key/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Write access/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('认证方式')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('SSH Private Key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('HTTPS Token')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /测试连接/ })).not.toBeInTheDocument();
  });

  it('keeps add repo visible but denies opening it for read-only members', async () => {
    const errorSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    let createRequests = 0;
    server.use(
      http.get('/api/repos', () => HttpResponse.json({
        success: true, code: '0', message: '', traceId: null, data: [],
      })),
      http.post('/api/repos', () => {
        createRequests += 1;
        return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null });
      }),
    );

    renderPage('READ_ONLY');
    const addButton = await screen.findByRole('button', { name: /添加仓库/ });
    await userEvent.click(addButton);

    expect(errorSpy).toHaveBeenCalledWith('当前为只读权限，添加仓库需要读写权限');
    expect(screen.queryByRole('dialog', { name: /添加仓库/ })).not.toBeInTheDocument();
    expect(createRequests).toBe(0);
    errorSpy.mockRestore();
  });

  it('blocks creating a repo whose name contains a path separator', async () => {
    const user = userEvent.setup();
    let createRequests = 0;
    server.use(
      http.get('/api/repos', () => HttpResponse.json({
        success: true, code: '0', message: '', traceId: null, data: [],
      })),
      http.post('/api/repos', () => {
        createRequests += 1;
        return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null });
      }),
    );

    renderPage();

    await user.click(screen.getByRole('button', { name: /添加仓库/ }));
    await user.type(screen.getByLabelText('仓库名称'), 'api-tool-agent/terraform-provider-alicloud');
    await user.type(screen.getByLabelText('仓库地址'), 'https://github.com/api-tool-agent/terraform-provider-alicloud.git');
    await user.click(screen.getByRole('button', { name: '确 定' }));

    expect(await screen.findByText(/仓库名称必须为单级目录名/)).toBeInTheDocument();
    expect(screen.getByText(/namespace\/repo-name/)).toBeInTheDocument();
    await waitFor(() => expect(createRequests).toBe(0));
  });

  it('still creates a repo when the name is a legal single segment', async () => {
    const user = userEvent.setup();
    let createRequests = 0;
    server.use(
      http.get('/api/repos', () => HttpResponse.json({
        success: true, code: '0', message: '', traceId: null, data: [],
      })),
      http.post('/api/repos', () => {
        createRequests += 1;
        return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null });
      }),
    );

    renderPage();

    await user.click(screen.getByRole('button', { name: /添加仓库/ }));
    await user.type(screen.getByLabelText('仓库名称'), 'terraform-provider-alicloud');
    await user.type(screen.getByLabelText('仓库地址'), 'https://github.com/api-tool-agent/terraform-provider-alicloud.git');
    await user.click(screen.getByRole('button', { name: '确 定' }));

    await waitFor(() => expect(createRequests).toBe(1));
    expect(screen.queryByText(/仓库名称必须为单级目录名/)).not.toBeInTheDocument();
  });

  it('deletes repo via operations column with confirmation', async () => {
    const user = userEvent.setup();
    let deletedId: number | null = null;
    const successSpy = vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
    server.use(
      http.get('/api/repos', () => HttpResponse.json({
        success: true, code: '0', message: '', traceId: null,
        data: [{ id: 42, name: 'to-delete', url: 'https://example.com/r.git', defaultBranch: 'main', description: null, scanStatus: null, version: 1, gmtCreate: '2026-07-01' }],
      })),
      http.delete('/api/repos/42', () => {
        deletedId = 42;
        return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null });
      }),
    );

    renderPage();
    const nameLink = await screen.findByRole('link', { name: 'to-delete' });
    expect(nameLink).toHaveAttribute('href', '/repos/42');
    const deleteBtn = screen.getByRole('button', { name: '删除仓库 to-delete' });
    await user.click(deleteBtn);

    expect(await screen.findByText(/确认删除仓库/)).toBeInTheDocument();
    const confirmBtn = document.querySelector('.ant-popconfirm .ant-popconfirm-buttons button:last-child') as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    await user.click(confirmBtn);

    await waitFor(() => expect(deletedId).toBe(42));
    expect(successSpy).toHaveBeenCalledWith('仓库已删除');
    successSpy.mockRestore();
  });
});

describe('RepoListPage copy repository URL', () => {
  beforeEach(() => {
    copyMock.mockReset();
  });

  it('renders one copy control per row named after its repository', async () => {
    mockRepoList([repoRow(1, 'repo-a', httpUrl), repoRow(2, 'repo-b', sshUrl)]);
    renderPage();

    expect(await copyButton('repo-a')).toBeInTheDocument();
    expect(await copyButton('repo-b')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /复制仓库「/ })).toHaveLength(2);
  });

  it('renders no copy control when the list is empty', async () => {
    mockRepoList([]);
    renderPage();

    await waitFor(() => expect(document.querySelector('.ant-empty')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /复制仓库/ })).not.toBeInTheDocument();
  });

  it('copies the stored URL of each row verbatim, including long and SSH addresses', async () => {
    const user = userEvent.setup();
    copyMock.mockResolvedValue(true);
    mockRepoList([repoRow(1, 'long-repo', longUrl), repoRow(2, 'ssh-repo', sshUrl)]);
    renderPage();

    await user.click(await copyButton('long-repo'));
    await waitFor(() => expect(copyMock).toHaveBeenLastCalledWith(longUrl));
    expect(copyMock.mock.calls[0][0]).toHaveLength(longUrl.length);
    expect(copyMock.mock.calls[0][0]).toBe(longUrl);

    await user.click(await copyButton('ssh-repo'));
    await waitFor(() => expect(copyMock).toHaveBeenLastCalledWith(sshUrl));
    expect(copyMock.mock.calls[1][0]).toBe('git@gitlab.example.com:community/auto-wonder.git');
  });

  it('waits for the copy result before reporting and shows success only for true', async () => {
    const user = userEvent.setup();
    let finish!: (copied: boolean) => void;
    copyMock.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const successSpy = vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    mockRepoList([repoRow(1, 'repo-a', httpUrl)]);
    renderPage();

    await user.click(await copyButton('repo-a'));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(httpUrl));
    expect(successSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    finish(true);
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith('仓库地址已复制'));
    expect(errorSpy).not.toHaveBeenCalled();
    successSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reports failure and no success when the copy falls back unsuccessfully', async () => {
    const user = userEvent.setup();
    copyMock.mockResolvedValue(false);
    const successSpy = vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    mockRepoList([repoRow(1, 'repo-a', httpUrl)]);
    renderPage();

    await user.click(await copyButton('repo-a'));

    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('自动复制失败，请手动复制'));
    expect(successSpy).not.toHaveBeenCalled();
    successSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('copies for read-only members without any write request', async () => {
    const user = userEvent.setup();
    copyMock.mockResolvedValue(true);
    let writeRequests = 0;
    server.use(
      http.get('/api/repos', () => HttpResponse.json({
        success: true, code: '0', message: '', traceId: null, data: [repoRow(1, 'repo-a', httpUrl)],
      })),
      http.post('/api/repos', () => { writeRequests += 1; return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null }); }),
      http.put('/api/repos/:id', () => { writeRequests += 1; return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null }); }),
      http.patch('/api/repos/:id', () => { writeRequests += 1; return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null }); }),
      http.delete('/api/repos/:id', () => { writeRequests += 1; return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: null }); }),
    );
    renderPage('READ_ONLY');

    const button = await copyButton('repo-a');
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(httpUrl));
    expect(writeRequests).toBe(0);
  });

  it('is keyboard operable with Tab, Enter and Space', async () => {
    const user = userEvent.setup();
    copyMock.mockResolvedValue(true);
    mockRepoList([repoRow(1, 'repo-a', httpUrl)]);
    renderPage();

    const button = await copyButton('repo-a');
    for (let presses = 0; presses < 10 && document.activeElement !== button; presses += 1) {
      await user.tab();
    }
    expect(button).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
    expect(copyMock).toHaveBeenLastCalledWith(httpUrl);

    await user.keyboard(' ');
    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(2));
  });
});
