import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';

/**
 * NONE of these routes carry @Public(). §11.5/§9.4: @Public() only exists for
 * api-gateway's own JwtAuthGuard — a downstream service declaring it would
 * skip InternalContextGuard's signature verification entirely, which is
 * exactly the bypass the architecture forbids (§13.7 row 6). /login and
 * /refresh are reachable with no authenticated identity because the gateway
 * signs an ANONYMOUS context for them (§9.4) — the signature is still
 * verified here like any other request; it just asserts no identity.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<LoginResponseDto> {
    return this.auth.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
