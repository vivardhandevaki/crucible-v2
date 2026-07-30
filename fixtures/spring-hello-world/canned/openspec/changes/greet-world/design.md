# Design — greet-world

`GreetingService` owns the greeting text and remains a Spring `@Service`.
A `@SpringBootTest` loads the real application context and resolves the service
bean before asserting the one approved response. The oracle method is a plain
`@Test` addressed as `Class#method`, so discovery and execution use the same
contract as any other JUnit-based framework.
