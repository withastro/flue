import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from '@tanstack/react-router'
import { AppSidebar } from '@/components/app-sidebar'
import { ChatView } from '@/components/chat/chat-view'
import { NewChat } from '@/components/new-chat'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

function RootLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}

function ChatRoute() {
  const { chatId } = useParams({ from: '/c/$chatId' })
  // Remount when the conversation changes so per-conversation state resets.
  return <ChatView key={chatId} conversationId={chatId} />
}

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: NewChat,
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/c/$chatId',
  component: ChatRoute,
})

const routeTree = rootRoute.addChildren([indexRoute, chatRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
