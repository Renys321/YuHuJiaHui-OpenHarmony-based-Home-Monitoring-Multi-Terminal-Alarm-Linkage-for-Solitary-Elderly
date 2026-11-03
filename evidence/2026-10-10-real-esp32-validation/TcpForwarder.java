import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;

public final class TcpForwarder {
    private static void pump(Socket source, Socket destination) {
        try {
            source.getInputStream().transferTo(destination.getOutputStream());
            destination.shutdownOutput();
        } catch (IOException ignored) {
            // Closing either side is enough to terminate the paired forwarding task.
        }
    }

    private static void forward(Socket client, String host, int port) {
        try (client; Socket upstream = new Socket(host, port)) {
            System.out.printf("forwarding %s -> %s:%d%n", client.getRemoteSocketAddress(), host, port);
            Thread clientToUpstream = Thread.ofVirtual().start(() -> pump(client, upstream));
            Thread upstreamToClient = Thread.ofVirtual().start(() -> pump(upstream, client));
            clientToUpstream.join();
            upstreamToClient.join();
        } catch (Exception error) {
            System.err.printf("forwarding failed for %s: %s%n", client.getRemoteSocketAddress(), error);
        }
    }

    public static void main(String[] args) throws IOException {
        int listenPort = Integer.parseInt(args[0]);
        String targetHost = args[1];
        int targetPort = Integer.parseInt(args[2]);

        try (ServerSocket server = new ServerSocket()) {
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress("0.0.0.0", listenPort));
            System.out.printf("listening on 0.0.0.0:%d -> %s:%d%n", listenPort, targetHost, targetPort);
            while (true) {
                Socket client = server.accept();
                Thread.ofVirtual().start(() -> forward(client, targetHost, targetPort));
            }
        }
    }
}
