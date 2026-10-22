/** Every user repository function takes this and adds `user_id = ctx.userId` to its queries. */
export interface UserContext {
  userId: string;
}
